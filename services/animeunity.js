const fetch = require("node-fetch");
const debug = require("../debug");

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

// The assembled catalog (dubbed anime ordered by latest episode, mapped to
// Kitsu ids) is cached so scrolling/pagination doesn't refetch the feed.
let catalogCache = null; // { metas, builtAt }
const CATALOG_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Kitsu mappings are static, so cache them for the whole process lifetime.
// Key: "anilist/anime:889" or "myanimelist/anime:889" → kitsu id (or null).
const kitsuCache = new Map();

// Search results (the "all dubbed anime" search-only catalog) are cached per
// normalized query, so paging through results doesn't re-hit AnimeUnity.
const searchCache = new Map(); // normalizedQuery → { metas, builtAt }
const SEARCH_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SEARCH_API_PAGE = 30; // archivio/get-animes returns up to 30 records/page
const MAX_SEARCH_PAGES = 6; // cap work per query (~180 results)

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
async function fetchFeedPage(page) {
  const url = page > 1 ? `${AU_BASE}/?page=${page}` : `${AU_BASE}/`;
  debug(`AnimeUnity: feed page ${page}`);
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  if (!res.ok) throw new Error(`AnimeUnity feed error: ${res.status}`);

  const html = await res.text();
  const m = html.match(/<layout-items[^>]*items-json="([^"]*)"/);
  if (!m) {
    debug(`AnimeUnity: no items-json on page ${page}`);
    return [];
  }
  try {
    const json = JSON.parse(decodeEntities(m[1]));
    return Array.isArray(json.data) ? json.data : [];
  } catch (err) {
    debug(`AnimeUnity: failed to parse feed page ${page}: ${err.message}`);
    return [];
  }
}

// Walk the latest-episodes feed, keeping the first (most recent) occurrence of
// each *dubbed* anime. The result is dubbed anime ordered by the recency of
// their latest dubbed episode — so the first one is the anime whose newest
// episode just dropped.
async function collectDubbedAnime() {
  const ordered = [];
  const seen = new Set();

  for (let page = 1; page <= MAX_FEED_PAGES; page++) {
    let items;
    try {
      items = await fetchFeedPage(page);
    } catch (err) {
      debug(`AnimeUnity: stopping feed walk at page ${page}: ${err.message}`);
      break;
    }
    if (items.length === 0) break;

    for (const item of items) {
      const anime = item.anime;
      if (!anime || anime.dub !== 1) continue;
      if (seen.has(anime.id)) continue;
      seen.add(anime.id);
      // Remember the latest episode number/date for display.
      ordered.push({ ...anime, _latestEpisode: item.number, _episodeAt: item.created_at });
    }

    if (ordered.length >= TARGET_ANIME) break;
  }

  debug(`AnimeUnity: collected ${ordered.length} distinct dubbed anime`);
  return ordered;
}

// Resolve an external id (AniList or MAL) to a Kitsu anime id via Kitsu's
// mappings endpoint. Cached; returns null when no mapping exists.
async function mapToKitsu(externalSite, externalId) {
  if (!externalId) return null;
  const cacheKey = `${externalSite}:${externalId}`;
  if (kitsuCache.has(cacheKey)) return kitsuCache.get(cacheKey);

  const url =
    `${KITSU_API}/mappings?filter[externalSite]=${encodeURIComponent(externalSite)}` +
    `&filter[externalId]=${encodeURIComponent(externalId)}&include=item`;

  let kitsuId = null;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/vnd.api+json" },
    });
    if (res.ok) {
      const json = await res.json();
      kitsuId =
        json?.included?.[0]?.id ||
        json?.data?.[0]?.relationships?.item?.data?.id ||
        null;
    } else {
      debug(`Kitsu mapping ${cacheKey} status ${res.status}`);
    }
  } catch (err) {
    debug(`Kitsu mapping ${cacheKey} failed: ${err.message}`);
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

// title_eng often carries an "(ITA)" suffix from the dubbed entry; drop it for
// display, the catalog row already says these are dubbed.
function cleanTitle(anime) {
  const raw = anime.title_eng || anime.title || anime.title_it || "Anime";
  return raw.replace(/\s*\(ITA\)\s*$/i, "").trim();
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
      return {
        id: `kitsu:${kitsuId}`,
        type: "anime",
        name: cleanTitle(a),
        poster: a.imageurl || undefined,
        posterShape: "poster",
        background: a.imageurl_cover || undefined,
        description: a.plot || undefined,
        releaseInfo: a.date || undefined,
        imdbRating: a.score || undefined,
      };
    })
  );
  return previews.filter(Boolean);
}

// Build the full catalog: distinct dubbed anime (ordered by latest episode)
// turned into Stremio meta previews with Kitsu ids. Cached for CATALOG_TTL_MS.
async function buildCatalog() {
  if (catalogCache && Date.now() - catalogCache.builtAt < CATALOG_TTL_MS) {
    return catalogCache.metas;
  }

  const anime = await collectDubbedAnime();
  const metas = await recordsToMetas(anime);
  catalogCache = { metas, builtAt: Date.now() };
  debug(`buildCatalog: ${metas.length} kitsu meta(s) cached`);
  return metas;
}

// Return one catalog page. Stremio paginates by sending `skip` (items already
// loaded); we slice the assembled, ordered list accordingly.
async function getDubbedCatalog(skip) {
  const all = await buildCatalog();
  const start = skip || 0;
  return all.slice(start, start + CATALOG_PAGE_SIZE);
}

// Fetch (and cache) the CSRF token + cookies required to call the archivio
// search endpoint. AnimeUnity rotates these, so the context has its own TTL.
async function getAuContext() {
  if (auContext && Date.now() - auContext.builtAt < AU_CTX_TTL_MS) {
    return auContext;
  }
  const res = await fetch(`${AU_BASE}/`, {
    headers: { "User-Agent": UA, Accept: "text/html" },
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
async function fetchSearchPage(query, offset) {
  const ctx = await getAuContext();
  const res = await fetch(`${AU_BASE}/archivio/get-animes`, {
    method: "POST",
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
  if (!res.ok) throw new Error(`AnimeUnity search error: ${res.status}`);
  const json = await res.json();
  return Array.isArray(json.records) ? json.records : [];
}

// Build the full set of dubbed anime matching `query`, mapped to Kitsu metas.
// Walks the archivio pages (capped) and caches the result per query.
async function buildSearchResults(query) {
  const key = (query || "").trim().toLowerCase();
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.builtAt < SEARCH_TTL_MS) {
    return cached.metas;
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
  const metas = await recordsToMetas(records);
  searchCache.set(key, { metas, builtAt: Date.now() });
  return metas;
}

// Return one page of search results. Like the feed catalog, Stremio paginates
// by sending `skip` (items already loaded); we slice the assembled list.
async function searchDubbedCatalog(query, skip) {
  const all = await buildSearchResults(query);
  const start = skip || 0;
  return all.slice(start, start + CATALOG_PAGE_SIZE);
}

module.exports = { getDubbedCatalog, searchDubbedCatalog };
