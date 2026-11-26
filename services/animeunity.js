const malDubbed = require("./mal-dubbed");
const fetch = require("node-fetch");
const debug = require("../debug");
const { getTopAnime } = require("./mal");
const tmdb = require("./tmdb");
const animeworld = require("./animeworld");
const animeunity = require("./animeunity-source");
const bundledSnapshot = require("./dubbed-snapshot");
const { getDubbedEpisodes } = animeunity;
const KITSU_API = "https://kitsu.io/api/edge";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const CATALOG_PAGE_SIZE = 50; // anime returned per Stremio catalog page

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
    return bundledRecentFeed();
  }
  const bundled = !feedRecordsCache && bundledSnapshot.getRecent().length ? bundledRecentFeed() : null;
  if (!feedRecordsPending) {
    feedRecordsPending = loadFeedRecords().finally(() => { feedRecordsPending = null; });
    // The bundled feed can be served immediately on cold start while the live feeds update.
    if (bundled) feedRecordsPending.catch(error => debug(`Latest feed refresh failed: ${error.message}`));
  }
  return bundled ? Promise.resolve(bundled) : feedRecordsPending;
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
    animeunity.getRecent(), animeworld.getDubbedRecords(),
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
    return bundledRecentFeed();
  }
  feedRetryAt = 0;
  feedRecordsCache = { records: [...interleave(fresh), ...interleave(stale)], builtAt: now };
  return feedRecordsCache;
}

function bundledRecentFeed() {
  const records = bundledSnapshot.getRecent();
  if (!records.length) throw new Error("All latest dubbed sources unavailable");
  return { records, builtAt: Date.parse(bundledSnapshot.capturedAt), bundled: true };
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
  // Only the live cache may extend the lifetime of a recent feed.
  if (!feed.bundled) feedMetaCache[kind] = { metas, builtAt: feed.builtAt };
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

function searchableTitle(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFKD").toLowerCase()
    .replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

async function searchDubbedIndex(query) {
  const key = searchableTitle(query);
  if (!key) return [];
  let records = bundledSnapshot.archive;
  if (dubbedIndexCache && Date.now() - dubbedIndexCache.builtAt < SOURCE_STALE_MS) {
    records = [...dubbedIndexCache.index.values()];
  } else if (!records.length) {
    records = [...(await buildDubbedIndex()).values()];
  }
  return records.filter(record => {
    if (record._source === "MyAnimeList cast") return false;
    return [record.title, record.title_it, record.title_eng, record.title_ja]
      .some(title => searchableTitle(title).includes(key));
  });
}

// Share searches for series and films without caching upstream errors as misses.
const searchPending = new Map();
async function getSearchRecords(key) {
  const cached = searchRecordsCache.get(key);
  if (cached && Date.now() - cached.builtAt < SEARCH_TTL_MS) return cached;
  if (!searchPending.has(key)) {
    searchPending.set(key, animeunity.getArchive(key, MAX_SEARCH_PAGES).then(({ records, partial }) => {
      const unique = [...new Map(records.map(record => [record.id, record])).values()];
      const result = { records: unique, cacheable: !partial, builtAt: Date.now() };
      if (!partial) searchRecordsCache.set(key, result);
      return result;
    }).catch(async error => {
      if (cached && Date.now() - cached.builtAt < SOURCE_STALE_MS) return cached;
      debug(`AnimeUnity search unavailable: ${error.message}`);
      return { records: await searchDubbedIndex(key), cacheable: false };
    }).finally(() => searchPending.delete(key)));
  }
  return searchPending.get(key);
}

async function buildSearchResults(query, kind) {
  const normalized = (query || "").trim().toLowerCase();
  if (!normalized) return [];
  const key = `${kind}:${normalized}`;
  const cached = searchMetaCache.get(key);
  if (cached && Date.now() - cached.builtAt < SEARCH_TTL_MS) return cached.metas;
  const result = await getSearchRecords(normalized);
  const records = filterByKind(result.records, kind);
  const metas = await recordsToMetas(records);
  if (records.length && !metas.length) throw new Error("Kitsu mappings unavailable for search catalog");
  if (result.cacheable) searchMetaCache.set(key, { metas, builtAt: result.builtAt });
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

function addDubbedRecords(index, records) {
  for (const record of records) {
    if (record.mal_id == null) continue;
    const id = String(record.mal_id);
    if (!index.has(id)) index.set(id, record);
  }
}

async function loadDubbedIndex() {
  const cached = dubbedIndexCache;
  if (cached && Date.now() - cached.builtAt < cached.ttl) return cached.index;
  const index = new Map();
  try {
    const { records, partial } = await animeunity.getArchive("", ARCHIVE_PAGE_LIMIT);
    addDubbedRecords(index, records);
    if (partial && cached?.ttl === DUBBED_INDEX_TTL_MS && Date.now() - cached.builtAt < SOURCE_STALE_MS) {
      for (const [id, record] of cached.index) if (!index.has(id)) index.set(id, record);
    }
    if (!index.size) throw new Error("AnimeUnity dubbed archive is empty");
    if (partial) addDubbedRecords(index, bundledSnapshot.archive);
    dubbedIndexCache = { index, builtAt: Date.now(), ttl: partial ? 60000 : DUBBED_INDEX_TTL_MS };
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
      addDubbedRecords(alternate, [...result.records, ...latest].filter(record => record._dubbed));
      if (!result.complete || !alternate.size) addDubbedRecords(alternate, bundledSnapshot.archive);
      if (!alternate.size) throw new Error("AnimeWorld archive has no verified MAL mappings");
      dubbedIndexCache = { index: alternate, builtAt: Date.now(), ttl: result.complete ? DUBBED_INDEX_TTL_MS : 60000 };
      return alternate;
    } catch (fallbackError) {
      if (cached && Date.now() - cached.builtAt < SOURCE_STALE_MS) return cached.index;
      addDubbedRecords(index, bundledSnapshot.archive);
      if (index.size) {
        dubbedIndexCache = { index, builtAt: Date.now(), ttl: 60000 };
        return index;
      }
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

function getCatalogStatus() {
  return {
    bundledSnapshot: { capturedAt: bundledSnapshot.capturedAt, archive: bundledSnapshot.archive.length, recent: bundledSnapshot.getRecent().length },
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
