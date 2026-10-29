const malDubbed = require("./mal-dubbed");
const fetch = require("node-fetch");
const debug = require("../debug");
const { getTopAnime } = require("./mal");
const tmdb = require("./tmdb");
const animeworld = require("./animeworld");
const episodeNumber = require("./episode-numbers");

const AU_BASE = "https://www.animeunity.so";
const KITSU_API = "https://kitsu.io/api/edge";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// How many pages of the "ultimi episodi" feed to scan, and the target number of
// distinct dubbed anime to collect. Dubbed releases come in batches (a series
// dumps many episodes at once), so the set of *distinct* recently-dubbed anime
// is small — a couple dozen pages is plenty to cover it.
const CATALOG_PAGE_SIZE = 50; // anime returned per Stremio catalog page
const MAX_FEED_PAGES = 20;
const TARGET_ANIME = 60;

// Distinct dubbed anime from the latest-episodes feed (raw records, before the
// Kitsu mapping) are cached so the series and movie catalogs share one walk.
let feedRecordsCache = null; // { records, builtAt }
let feedRecordsPending = null;
let feedRetryAt = 0;
const sourceSnapshots = new Map();
const SOURCE_STALE_MS = 24 * 60 * 60 * 1000;
const FEED_RETRY_MS = 60 * 1000;
const CATALOG_TTL_MS = 10 * 60 * 1000; // 10 minutes
// Mapped Stremio metas split by kind ("series" vs "movie"), cached separately.
const feedMetaCache = { series: null, movie: null }; // kind → { metas, builtAt }
const feedMetaPending = {};

// Kitsu mappings are static, so cache them for the whole process lifetime.
// Key: "anilist/anime:889" or "myanimelist/anime:889" → kitsu id (or null).
const kitsuCache = new Map();
const kitsuPending = new Map();

// Search results (the "all dubbed anime" search-only catalog) are cached per
// normalized query, so paging through results doesn't re-hit AnimeUnity.
// Raw records are cached per query (shared by both kinds); mapped metas are
// cached per "kind:query".
const searchRecordsCache = new Map(); // normalizedQuery → { records, builtAt }
const searchMetaCache = new Map(); // "kind:normalizedQuery" → { metas, builtAt }
const SEARCH_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SEARCH_API_PAGE = 30; // archivio/get-animes returns up to 30 records/page
const MAX_SEARCH_PAGES = 6; // cap work per query (~180 results)

// "Top anime doppiati ITA" catalog: the MyAnimeList top ranking intersected
// with a confirmed dubbed archive (AnimeUnity, with AnimeWorld fallback).
// We walk the dubbed archive once
// to build an index keyed by mal_id, then keep the MAL-top entries that appear
// in it (preserving MAL rank order).
const ARCHIVE_PAGE_LIMIT = 60; // ~1800 records: covers the full dubbed archive
const MAX_TOP_MAL_PAGES = 20; // scan up to MAL top ~500 for dubbed matches
const TARGET_TOP_ANIME = 100; // stop once we've collected this many dubbed hits
// The dubbed archive changes slowly; cache the index for a long while.
let dubbedIndexCache = null; // { index: Map<malId, record>, builtAt }
const DUBBED_INDEX_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
// Matched MAL-top dubbed records are cached once (shared by both kinds); mapped
// metas are cached per kind.
let topRecordsCache = null; // { records, builtAt }
const topMetaCache = { series: null, movie: null }; // kind → { metas, builtAt }
const TOP_CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// "Top anime in onda ITA" catalog: MyAnimeList's top *airing* ranking
// (topanime.php?type=airing) intersected with the dubbed archive. The airing
// list is short (a few hundred anime), so we scan all of it; dubs lag behind
// simulcasts, so only a handful match — one home row, no series/movie split.
const MAX_AIRING_MAL_PAGES = 20;
let airingRecordsCache = null; // { records, builtAt }
let airingMetaCache = null; // { metas, builtAt }

// The archivio search endpoint is CSRF-protected: every request needs the
// csrf-token from the homepage <meta> plus the XSRF-TOKEN/session cookies it
// hands out. Cache that handshake briefly and reuse it across searches.
let auContext = null; // { csrf, xsrfToken, cookies, builtAt }
const AU_CTX_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Decode the HTML entities AnimeUnity uses inside the items-json attribute.
function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// The homepage (and ?page=N) embeds the latest-episodes feed as a Laravel
// paginator in <layout-items items-json="...">. Fetch a page and return its
// episode array (each item carries a nested `anime` object).
async function fetchFeedPage(page, timeout = 15000) {
  const url = page > 1 ? `${AU_BASE}/?page=${page}` : `${AU_BASE}/`;
  debug(`AnimeUnity: feed page ${page}`);
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    timeout,
  });
  if (!res.ok) throw new Error(`AnimeUnity feed error: ${res.status}`);

  const html = await res.text();
  const m = html.match(/<layout-items[^>]*items-json="([^"]*)"/);
  if (!m) {
    throw new Error(`AnimeUnity: no items-json on page ${page}`);
  }
  try {
    const json = JSON.parse(decodeEntities(m[1]));
    if (!Array.isArray(json.data)) throw new Error("Missing feed data array");
    return json.data;
  } catch (err) {
    throw new Error(`AnimeUnity: failed to parse feed page ${page}: ${err.message}`);
  }
}

// Walk the latest-episodes feed, keeping the first (most recent) occurrence of
// each *dubbed* anime. The result is dubbed anime ordered by the recency of
// their latest dubbed episode — so the first one is the anime whose newest
// episode just dropped.
async function collectDubbedAnime() {
  const ordered = [];
  const seen = new Set();
  const deadline = Date.now() + 20000;

  for (let page = 1; page <= MAX_FEED_PAGES; page++) {
    if (Date.now() >= deadline) break;
    let items;
    try {
      items = await fetchFeedPage(page, Math.max(1, Math.min(15000, deadline - Date.now())));
    } catch (err) {
      if (!ordered.length) throw err;
      debug(`AnimeUnity: stopping feed walk at page ${page}: ${err.message}`);
      break;
    }
    if (items.length === 0) break;

    for (const item of items) {
      const anime = item.anime;
      if (!anime || ![1, "1", true].includes(anime.dub)) continue;
      const number = episodeNumber(item.number);
      if (seen.has(anime.id)) {
        const previous = ordered.find((record) => record.id === anime.id);
        if (number && !previous._confirmedDubbedEpisodes.includes(number)) previous._confirmedDubbedEpisodes.push(number);
        continue;
      }
      seen.add(anime.id);
      // Remember the latest episode number/date for display.
      ordered.push({ ...anime, _latestEpisode: item.number, _episodeAt: item.created_at,
        _confirmedDubbedEpisodes: number ? [number] : [], _observedAt: Date.now() });
    }

    if (ordered.length >= TARGET_ANIME) break;
  }

  debug(`AnimeUnity: collected ${ordered.length} distinct dubbed anime`);
  if (!ordered.length) throw new Error("AnimeUnity dubbed feed is empty");
  return ordered;
}

// Resolve an external id (AniList or MAL) to a Kitsu anime id via Kitsu's
// mappings endpoint. Cached; returns null when no mapping exists.
async function mapToKitsu(externalSite, externalId) {
  if (!externalId) return null;
  const cacheKey = `${externalSite}:${externalId}`;
  if (kitsuCache.has(cacheKey)) return kitsuCache.get(cacheKey);
  if (!kitsuPending.has(cacheKey)) {
    const request = loadKitsuMapping(externalSite, externalId, cacheKey)
      .finally(() => kitsuPending.delete(cacheKey));
    kitsuPending.set(cacheKey, request);
  }
  return kitsuPending.get(cacheKey);
}

async function loadKitsuMapping(externalSite, externalId, cacheKey) {
  const url =
    `${KITSU_API}/mappings?filter[externalSite]=${encodeURIComponent(externalSite)}` +
    `&filter[externalId]=${encodeURIComponent(externalId)}&include=item`;

  let kitsuId = null;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/vnd.api+json" },
      timeout: 10000,
    });
    if (res.ok) {
      const json = await res.json();
      kitsuId =
        json?.included?.[0]?.id ||
        json?.data?.[0]?.relationships?.item?.data?.id ||
        null;
    } else {
      debug(`Kitsu mapping ${cacheKey} status ${res.status}`);
      return null;
    }
  } catch (err) {
    debug(`Kitsu mapping ${cacheKey} failed: ${err.message}`);
    return null;
  }

  kitsuCache.set(cacheKey, kitsuId);
  return kitsuId;
}

// Prefer AniList mapping, fall back to MyAnimeList.
async function resolveKitsuId(anime) {
  if (anime.anilist_id) {
    const id = await mapToKitsu("anilist/anime", anime.anilist_id);
    if (id) return id;
  }
  if (anime.mal_id) {
    const id = await mapToKitsu("myanimelist/anime", anime.mal_id);
    if (id) return id;
  }
  return null;
}

// Prefer the Italian title; AnimeUnity is an Italian site so title_it is the
// localized name. Titles often carry an "(ITA)" suffix from the dubbed entry;
// drop it for display, the catalog row already says these are dubbed.
function cleanTitle(anime) {
  const raw = anime.title_it || anime.title_eng || anime.title || "Anime";
  return raw.replace(/\s*\(ITA\)\s*$/i, "").trim();
}

// AnimeUnity's `plot` is the Italian synopsis. Some entries prefix it with the
// original/English title ("Attack on Titan (Shingeki no Kyojin) - …"); strip
// that lead-in, but only when the plot actually starts with a known title
// followed by a separator, so we never cut legitimate text.
function cleanPlot(anime) {
  const raw = anime && anime.plot;
  if (!raw) return undefined;
  const p = raw.trim();
  const known = [anime.title_eng, anime.title, anime.title_it]
    .filter(Boolean)
    .map((t) => t.replace(/\s*\(ITA\)\s*$/i, "").trim())
    .filter(Boolean);
  for (const t of known) {
    if (p.toLowerCase().startsWith(t.toLowerCase())) {
      // Drop the title, an optional "(original title)", and a " - " separator.
      const stripped = p.slice(t.length).replace(/^\s*(\([^)]*\))?\s*[-–—]\s+/, "");
      if (stripped !== p.slice(t.length)) return stripped.trim();
    }
  }
  return p;
}

// Italian title/plot from AnimeUnity, keyed by kitsu id, so the meta handler
// (which only receives a kitsu id) can show Italian text instead of Kitsu's
// English synopsis. Populated whenever we map records to metas.
const italianMetaCache = new Map(); // kitsuId → { name, description }
const dubbedSources = new Map(); // kitsuId → source records, scoped to exact mappings

function getDubbedSources(kitsuId) {
  return (dubbedSources.get(String(kitsuId)) || [])
    .filter((entry) => Date.now() - entry.at < SOURCE_STALE_MS);
}

function rememberDubbedSource(kitsuId, record) {
  if (String(record.id).startsWith("mal:")) return; // Cast credits do not verify episode availability.
  const source = String(record.id).startsWith("aw:") ? "AnimeWorld" : "AnimeUnity";
  const entries = getDubbedSources(kitsuId).filter((entry) => entry.source !== source || entry.record.id !== record.id);
  entries.push({ source, record, at: Date.now() });
  if (dubbedSources.size >= 2000) dubbedSources.delete(dubbedSources.keys().next().value);
  dubbedSources.set(String(kitsuId), entries);
}

function getItalianMeta(kitsuId) {
  return italianMetaCache.get(String(kitsuId)) || null;
}

// What TMDB needs to localize a catalog preview (title + year + kind), keyed by
// kitsu id. Used to fetch Italian titles for the home/search catalogs, whose
// AnimeUnity `title_it` is null for most anime.
const tmdbInfoCache = new Map(); // kitsuId → { isMovie, titles, year }

function stripIta(t) {
  return (t || "").replace(/\s*\(ITA\)\s*$/i, "").trim();
}

// AnimeUnity tags each anime with a `type` ("TV", "Movie", "OVA", "ONA",
// "Special"). We treat "TV" as a series and everything else as a movie.
function isSeries(record) {
  return record && record.type === "TV";
}

function filterByKind(records, kind) {
  if (kind === "series") return records.filter(isSeries);
  if (kind === "movie") return records.filter((r) => !isSeries(r));
  return records;
}

// Turn AnimeUnity anime records into Stremio meta previews with Kitsu ids.
// Anime without a Kitsu mapping are dropped (no ecosystem id → other addons
// couldn't attach streams/meta to them anyway). Order is preserved.
async function recordsToMetas(records) {
  const previews = await Promise.all(
    records.map(async (a) => {
      const kitsuId = await resolveKitsuId(a);
      if (!kitsuId) {
        debug(`No Kitsu mapping for "${cleanTitle(a)}" (au id ${a.id})`);
        return null;
      }
      rememberDubbedSource(kitsuId, a);
      const name = cleanTitle(a);
      const description = cleanPlot(a);
      // Remember the Italian title/plot so the meta handler (kitsu id only) can
      // show Italian text instead of Kitsu's English synopsis.
      italianMetaCache.set(String(kitsuId), { name, description });
      // Remember what TMDB needs to localize this preview's title later.
      tmdbInfoCache.set(String(kitsuId), {
        isMovie: a.type === "Movie",
        titles: [stripIta(a.title_eng), stripIta(a.title)].filter(Boolean),
        year: a.date ? String(a.date).slice(0, 4) : undefined,
      });
      return {
        id: `kitsu:${kitsuId}`,
        type: isSeries(a) ? "series" : "movie",
        name,
        poster: a.imageurl || undefined,
        posterShape: "poster",
        background: a.imageurl_cover || undefined,
        description,
        releaseInfo: a.date || undefined,
        imdbRating: a.score || undefined,
      };
    })
  );
  return previews.filter(Boolean);
}

// Localize one catalog page's titles/descriptions via TMDB (Italian), when a key
// is provided. Runs only on the sliced page (≤ CATALOG_PAGE_SIZE items) and
// TMDB results are cached by id, so the base catalog cache stays key-independent
// and isn't poisoned by a keyless warm-up. Items keep their AnimeUnity text when
// TMDB has no match.
async function localizePage(metas, tmdbKey) {
  if (!tmdbKey) return metas;
  return Promise.all(
    metas.map(async (m) => {
      const info = tmdbInfoCache.get(m.id.slice("kitsu:".length));
      if (!info) return m;
      try {
        const it = await tmdb.getItalianBasic(tmdbKey, info);
        if (it && (it.name || it.description)) {
          return {
            ...m,
            name: it.name || m.name,
            description: it.description || m.description,
          };
        }
      } catch (err) {
        debug(`TMDB localize ${m.id} failed: ${err.message}`);
      }
      return m;
    })
  );
}

// Raw records from both feeds, with a shared load for series and movies.
function getFeedRecords() {
  if (feedRecordsCache && Date.now() - feedRecordsCache.builtAt < CATALOG_TTL_MS) {
    return Promise.resolve(feedRecordsCache);
  }
  if (Date.now() < feedRetryAt) {
    if (feedRecordsCache && Date.now() - feedRecordsCache.builtAt < SOURCE_STALE_MS) return Promise.resolve(feedRecordsCache);
    return Promise.reject(new Error("Latest dubbed sources temporarily unavailable"));
  }
  if (!feedRecordsPending) {
    feedRecordsPending = loadFeedRecords().finally(() => { feedRecordsPending = null; });
  }
  return feedRecordsPending;
}

// The verified AnimeWorld feed exposes no publication timestamps. Interleave
// source rankings instead of comparing AU timestamps with invented AW dates.
// Fresh sources precede
// last-known source snapshots, which are retained for at most 24 hours.
function interleave(lists) {
  const records = [];
  const length = Math.max(0, ...lists.map((list) => list.length));
  for (let index = 0; index < length; index++) {
    for (const list of lists) if (list[index]) records.push(list[index]);
  }
  return records;
}

async function loadFeedRecords() {
  const sources = ["AnimeUnity", "AnimeWorld"];
  const results = await Promise.allSettled([
    collectDubbedAnime(), animeworld.getDubbedRecords(),
  ]);
  const fresh = [];
  const stale = [];
  const now = Date.now();
  results.forEach((result, index) => {
    const source = sources[index];
    if (result.status === "fulfilled" && result.value.length) {
      const records = result.value.map((record) => ({ ...record, _source: source }));
      sourceSnapshots.set(source, { records, builtAt: now });
      fresh.push(records);
    } else {
      console.error(`${source} latest feed unavailable: ${result.reason?.message || "empty feed"}`);
      const snapshot = sourceSnapshots.get(source);
      if (snapshot && now - snapshot.builtAt < SOURCE_STALE_MS) stale.push(snapshot.records);
    }
  });
  if (!fresh.length) {
    feedRetryAt = now + FEED_RETRY_MS;
    // Keep the previous catalog's age, so later failures never extend its life.
    if (feedRecordsCache && now - feedRecordsCache.builtAt < SOURCE_STALE_MS) {
      const validSources = new Set(stale.flat().map((record) => record._source));
      feedRecordsCache = {
        ...feedRecordsCache,
        records: feedRecordsCache.records.filter((record) => validSources.has(record._source)),
      };
      return feedRecordsCache;
    }
    throw new Error("All latest dubbed sources unavailable");
  }
  feedRetryAt = 0;
  feedRecordsCache = { records: [...interleave(fresh), ...interleave(stale)], builtAt: now };
  return feedRecordsCache;
}

// Build the latest-dubbed catalog for one kind ("series" | "movie"): the feed
// records filtered by kind, turned into Stremio meta previews with Kitsu ids.
// Cached per kind for CATALOG_TTL_MS.
function buildCatalog(kind) {
  const cached = feedMetaCache[kind];
  if (cached && Date.now() - cached.builtAt < CATALOG_TTL_MS) {
    return Promise.resolve(cached.metas);
  }
  if (!feedMetaPending[kind]) {
    feedMetaPending[kind] = loadCatalog(kind).catch((error) => {
      if (cached && Date.now() - cached.builtAt < SOURCE_STALE_MS) return cached.metas;
      throw error;
    }).finally(() => { delete feedMetaPending[kind]; });
  }
  return feedMetaPending[kind];
}

async function loadCatalog(kind) {
  const feed = await getFeedRecords();
  const records = filterByKind(feed.records, kind);
  const mapped = await recordsToMetas(records);
  if (records.length && !mapped.length) throw new Error("Kitsu mappings unavailable for latest catalog");
  const seen = new Set();
  const metas = mapped.filter((meta) => {
    if (seen.has(meta.id)) return false;
    seen.add(meta.id);
    return true;
  });
  feedMetaCache[kind] = { metas, builtAt: feed.builtAt };
  debug(`buildCatalog(${kind}): ${metas.length} distinct kitsu meta(s) cached`);
  return metas;
}

// Return one catalog page. Stremio paginates by sending `skip` (items already
// loaded); we slice the assembled, ordered list accordingly.
async function getDubbedCatalog(kind, skip, tmdbKey) {
  const all = await buildCatalog(kind);
  const start = skip || 0;
  return localizePage(all.slice(start, start + CATALOG_PAGE_SIZE), tmdbKey);
}

// Fetch (and cache) the CSRF token + cookies required to call the archivio
// search endpoint. AnimeUnity rotates these, so the context has its own TTL.
async function getAuContext() {
  if (auContext && Date.now() - auContext.builtAt < AU_CTX_TTL_MS) {
    return auContext;
  }
  const res = await fetch(`${AU_BASE}/`, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`AnimeUnity home error: ${res.status}`);

  const setCookie = res.headers.raw()["set-cookie"] || [];
  const html = await res.text();
  const meta = html.match(/<meta name="csrf-token" content="([^"]+)"/);
  const cookies = setCookie.map((c) => c.split(";")[0]).join("; ");
  const xsrf = setCookie.find((c) => c.startsWith("XSRF-TOKEN="));
  const xsrfToken = xsrf
    ? decodeURIComponent(xsrf.split(";")[0].split("=")[1])
    : "";

  auContext = { csrf: meta ? meta[1] : "", xsrfToken, cookies, builtAt: Date.now() };
  debug(`AnimeUnity: refreshed archivio context (csrf ${auContext.csrf ? "ok" : "missing"})`);
  return auContext;
}

// One page of the dubbed archivio search. `offset` is a raw record offset.
async function fetchSearchPage(query, offset, retry = true) {
  const ctx = await getAuContext();
  const res = await fetch(`${AU_BASE}/archivio/get-animes`, {
    method: "POST",
    timeout: 15000,
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-TOKEN": ctx.csrf,
      "X-XSRF-TOKEN": ctx.xsrfToken,
      Cookie: ctx.cookies,
      Referer: `${AU_BASE}/archivio`,
    },
    body: JSON.stringify({
      title: query || "",
      type: false,
      year: false,
      order: false,
      status: false,
      genres: false,
      offset,
      dubbed: true,
      season: false,
    }),
  });
  if (res.status === 419 && retry) {
    auContext = null;
    return fetchSearchPage(query, offset, false);
  }
  if (!res.ok) throw new Error(`AnimeUnity search error: ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json.records)) throw new Error("Invalid AnimeUnity archive response");
  return json.records;
}

// Walk the archivio pages (capped) for `query` and return the raw dubbed
// records. Cached per normalized query, shared by the series and movie catalogs.
async function getSearchRecords(query) {
  const key = (query || "").trim().toLowerCase();
  const cached = searchRecordsCache.get(key);
  if (cached && Date.now() - cached.builtAt < SEARCH_TTL_MS) {
    return cached.records;
  }

  const records = [];
  const seen = new Set();
  let offset = 0;
  for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
    let pageRecords;
    try {
      pageRecords = await fetchSearchPage(query, offset);
    } catch (err) {
      debug(`AnimeUnity: stopping search walk at offset ${offset}: ${err.message}`);
      break;
    }
    if (pageRecords.length === 0) break;
    offset += pageRecords.length;
    for (const r of pageRecords) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      records.push(r);
    }
    if (pageRecords.length < SEARCH_API_PAGE) break; // last page
  }

  debug(`AnimeUnity: search "${key}" → ${records.length} dubbed record(s)`);
  searchRecordsCache.set(key, { records, builtAt: Date.now() });
  return records;
}

// Build the set of dubbed anime matching `query` for one kind ("series" |
// "movie"), mapped to Kitsu metas. Cached per "kind:query".
async function buildSearchResults(query, kind) {
  const key = `${kind}:${(query || "").trim().toLowerCase()}`;
  const cached = searchMetaCache.get(key);
  if (cached && Date.now() - cached.builtAt < SEARCH_TTL_MS) {
    return cached.metas;
  }
  const records = filterByKind(await getSearchRecords(query), kind);
  const metas = await recordsToMetas(records);
  searchMetaCache.set(key, { metas, builtAt: Date.now() });
  return metas;
}

// Return one page of search results. Like the feed catalog, Stremio paginates
// by sending `skip` (items already loaded); we slice the assembled list.
async function searchDubbedCatalog(query, kind, skip, tmdbKey) {
  const all = await buildSearchResults(query, kind);
  const start = skip || 0;
  return localizePage(all.slice(start, start + CATALOG_PAGE_SIZE), tmdbKey);
}

// Walk AnimeUnity's full dubbed archive (empty query) and index every record
// by its MyAnimeList id, so we can quickly tell whether a MAL-top anime is
// available dubbed. Cached for DUBBED_INDEX_TTL_MS.
let dubbedIndexPending = null;
function buildDubbedIndex() {
  if (!dubbedIndexPending) {
    dubbedIndexPending = loadDubbedIndex().finally(() => { dubbedIndexPending = null; });
  }
  return dubbedIndexPending;
}

async function loadDubbedIndex() {
  const cached = dubbedIndexCache;
  if (cached && Date.now() - cached.builtAt < cached.ttl) return cached.index;
  const index = new Map();
  try {
    let offset = 0;
    for (let page = 0; page < ARCHIVE_PAGE_LIMIT; page++) {
      const records = await fetchSearchPage("", offset);
      if (!records.length) break;
      offset += records.length;
      for (const record of records) if (record.mal_id != null && !index.has(String(record.mal_id))) index.set(String(record.mal_id), record);
      if (records.length < SEARCH_API_PAGE) break;
    }
    if (!index.size) throw new Error("AnimeUnity dubbed archive is empty");
    dubbedIndexCache = { index, builtAt: Date.now(), ttl: DUBBED_INDEX_TTL_MS };
    return index;
  } catch (error) {
    console.error(`AnimeUnity archive unavailable: ${error.message}`);
    // A cold restart used to lose all three Top rows here. The alternate
    // archive confirms dubbed audio; MAL still supplies ranking and ordering.
    try {
      const [archiveResult, latestResult] = await Promise.allSettled([
        animeworld.getDubbedArchive(), animeworld.getDubbedRecords(),
      ]);
      const result = archiveResult.status === "fulfilled" ? archiveResult.value : { records: [], complete: false };
      const latest = latestResult.status === "fulfilled" ? latestResult.value : [];
      const alternate = new Map();
      // Recent confirmed dubs also cover newly airing shows before the full
      // archive scan finishes, preserving MAL's airing ranking as well.
      for (const record of [...result.records, ...latest]) {
        if (record._dubbed && record.mal_id != null && !alternate.has(String(record.mal_id))) alternate.set(String(record.mal_id), record);
      }
      if (!alternate.size) throw new Error("AnimeWorld archive has no verified MAL mappings");
      dubbedIndexCache = { index: alternate, builtAt: Date.now(), ttl: result.complete ? DUBBED_INDEX_TTL_MS : 60000 };
      return alternate;
    } catch (fallbackError) {
      if (cached && Date.now() - cached.builtAt < SOURCE_STALE_MS) return cached.index;
      throw new Error(`Dubbed archives unavailable: ${error.message}; ${fallbackError.message}`);
    }
  }
}

// An incomplete alternate archive must not freeze Top rows for six hours.
const topTtl = () => Math.min(TOP_CATALOG_TTL_MS, dubbedIndexCache?.ttl || 60000);
const topFresh = cached => cached && Date.now() - cached.builtAt < (cached.ttl || TOP_CATALOG_TTL_MS);

// Match MyAnimeList's top ranking against the dubbed archive, preserving MAL
// rank order, and return the matched raw records. Cached once and shared by the
// series and movie top catalogs.
let topRecordsPending = null;
function getTopDubbedRecords() {
  if (!topRecordsPending) {
    topRecordsPending = loadTopDubbedRecords().finally(() => { topRecordsPending = null; });
  }
  return topRecordsPending;
}

async function loadTopDubbedRecords() {
  if (topFresh(topRecordsCache)) {
    return topRecordsCache.records;
  }

  const [index, top] = await Promise.all([buildDubbedIndex().catch(() => new Map()), getTopAnime(MAX_TOP_MAL_PAGES)]);
  if (!index.size || dubbedIndexCache?.ttl < DUBBED_INDEX_TTL_MS) {
    for (const record of await malDubbed.getDubbedMatches(top)) if (!index.has(String(record.mal_id))) index.set(String(record.mal_id), record);
  }

  const matched = [];
  const seen = new Set();
  for (const entry of top) {
    const record = index.get(String(entry.mal_id));
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    matched.push(record);
    if (matched.length >= TARGET_TOP_ANIME) break;
  }

  debug(`getTopDubbedRecords: ${matched.length} MAL-top anime are dubbed`);
  topRecordsCache = { records: matched, builtAt: Date.now(), ttl: topTtl() };
  return matched;
}

// Build the "Top ... ITA" catalog for one kind ("series" | "movie"): the matched
// MAL-top dubbed records filtered by kind, mapped to Kitsu metas. Cached per kind.
async function buildTopDubbedCatalog(kind) {
  const cached = topMetaCache[kind];
  if (topFresh(cached)) {
    return cached.metas;
  }
  const records = filterByKind(await getTopDubbedRecords(), kind);
  const metas = await recordsToMetas(records);
  if (records.length && !metas.length) throw new Error("Kitsu mappings unavailable for top catalog");
  topMetaCache[kind] = { metas, builtAt: Date.now(), ttl: topTtl() };
  return metas;
}

// Return one page of the top-dubbed catalog. Stremio paginates via `skip`.
async function getTopDubbedCatalog(kind, skip, tmdbKey) {
  const all = await buildTopDubbedCatalog(kind);
  const start = skip || 0;
  return localizePage(all.slice(start, start + CATALOG_PAGE_SIZE), tmdbKey);
}

// Match MyAnimeList's top *airing* ranking against the dubbed archive,
// preserving MAL rank order, and return the matched raw records.
async function getTopAiringDubbedRecords() {
  if (topFresh(airingRecordsCache)) {
    return airingRecordsCache.records;
  }

  const [index, top] = await Promise.all([
    buildDubbedIndex().catch(() => new Map()),
    getTopAnime(MAX_AIRING_MAL_PAGES, "airing"),
  ]);

  const matched = [];
  const seen = new Set();
  for (const entry of top) {
    const record = index.get(String(entry.mal_id));
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    matched.push(record);
  }

  // The alternate archive may still be scanning older high-rated shows.
  // Confirm MAL's airing candidates directly rather than hiding this row until
  // archive pagination eventually reaches recent dubs such as One Piece.
  if (typeof animeworld.getDubbedMatches === "function" && (!matched.length || dubbedIndexCache?.ttl < DUBBED_INDEX_TTL_MS)) {
    const verified = await animeworld.getDubbedMatches(top);
    const byMal = new Map([...matched, ...verified.filter(r => r._dubbed)].map(r => [String(r.mal_id), r]));
    matched.length = 0;
    seen.clear();
    for (const entry of top) {
      const record = byMal.get(String(entry.mal_id));
      if (record && !seen.has(record.id)) { seen.add(record.id); matched.push(record); }
    }
  }

  if (!matched.length || !dubbedIndexCache || dubbedIndexCache.ttl < DUBBED_INDEX_TTL_MS) {
    const records = await malDubbed.getDubbedMatches(top);
    const byMal = new Map([...matched, ...records].map(r => [String(r.mal_id), r]));
    matched.length = 0; seen.clear();
    for (const entry of top) {
      const record = byMal.get(String(entry.mal_id));
      if (record && !seen.has(record.id)) { seen.add(record.id); matched.push(record); }
    }
  }
  debug(`getTopAiringDubbedRecords: ${matched.length} MAL-top airing anime are dubbed`);
  airingRecordsCache = { records: matched, builtAt: Date.now(), ttl: matched.length ? topTtl() : 60000 };
  return matched;
}

// Build the "Top anime in onda ITA" catalog: matched airing dubbed records
// mapped to Kitsu metas (both series and movies — the row is a single mix).
async function buildTopAiringDubbedCatalog() {
  if (topFresh(airingMetaCache)) {
    return airingMetaCache.metas;
  }
  const records = await getTopAiringDubbedRecords();
  const metas = await recordsToMetas(records);
  if (records.length && !metas.length) throw new Error("Kitsu mappings unavailable for airing catalog");
  airingMetaCache = { metas, builtAt: Date.now(), ttl: Math.min(topTtl(), airingRecordsCache?.ttl || topTtl()) };
  return metas;
}

// Return one page of the top-airing-dubbed catalog. Stremio paginates via `skip`.
async function getTopAiringDubbedCatalog(skip, tmdbKey) {
  const all = await buildTopAiringDubbedCatalog();
  const start = skip || 0;
  return localizePage(all.slice(start, start + CATALOG_PAGE_SIZE), tmdbKey);
}

// The metadata endpoint returns actual episode records in windows of 120.
// A total/count only bounds requests; it never confirms episodes by itself.
async function getDubbedEpisodes(record, total) {
  if (!/^\d+$/.test(String(record.id))) return [];
  const slug = typeof record.slug === "string" && /^[\w-]+$/.test(record.slug) ? `-${record.slug}` : "";
  const apiId = `${record.id}${slug}`;
  const deadline = Date.now() + 10000;
  const numbers = new Set();
  const count = Math.min(3600, Math.max(1, Number(total) || 0));
  for (let start = 1; start <= count && Date.now() < deadline; start += 120) {
    const end = Math.min(start + 119, count);
    let json;
    try {
      const response = await fetch(`${AU_BASE}/info_api/${apiId}/0?start_range=${start}&end_range=${end}`, {
        headers: { "User-Agent": UA, Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
        timeout: Math.max(1, Math.min(5000, deadline - Date.now())),
      });
      if (!response.ok) throw new Error(`AnimeUnity episode metadata error: ${response.status}`);
      json = await response.json();
      if (!Array.isArray(json.episodes)) throw new Error("Invalid AnimeUnity episode list");
    } catch (error) {
      if (!numbers.size) throw error;
      debug(`AnimeUnity episode page unavailable: ${error.message}`);
      break;
    }
    for (const episode of json.episodes) {
      if (episode.anime_id != null && String(episode.anime_id) !== String(record.id)) continue;
      if (!episode.id || [false, 0, "0"].includes(episode.is_uploaded) || [false, 0, "0"].includes(episode.available)) continue;
      const number = episodeNumber(episode.number);
      if (number) numbers.add(number);
    }
    if (!json.episodes.length) break;
  }
  return [...numbers];
}

function getCatalogStatus() {
  return {
    dubbedIndex: dubbedIndexCache ? { count: dubbedIndexCache.index.size, partial: dubbedIndexCache.ttl < DUBBED_INDEX_TTL_MS } : null,
    airingRecords: airingRecordsCache?.records.length ?? null,
    airingMetas: airingMetaCache?.metas.length ?? null,
    rankings: require("./mal").getRankingStatus(),
    verification: animeworld.getRankedStatus(),
    italianCast: malDubbed.getStatus(),
  };
}

module.exports = {
  getCatalogStatus,
  getDubbedCatalog,
  searchDubbedCatalog,
  getTopDubbedCatalog,
  getTopAiringDubbedCatalog,
  getItalianMeta,
  getDubbedSources,
  getDubbedEpisodes,
};
