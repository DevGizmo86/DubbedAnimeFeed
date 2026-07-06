const fetch = require("node-fetch");
const debug = require("../debug");

// Jikan is the public REST API over MyAnimeList. /top/anime returns the same
// ranking as https://myanimelist.net/topanime.php but as clean JSON, so we
// avoid scraping the (fragile) HTML page.
const JIKAN_API = "https://api.jikan.moe/v4";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const PAGE_SIZE = 25; // Jikan caps /top/anime at 25 records per page
// Jikan rate-limits to ~3 req/s (and ~60/min); space requests out to stay well
// under it, and back off harder when it still answers 429.
const REQUEST_DELAY_MS = 500;
const RATE_LIMIT_BACKOFF_MS = 2000;

// The MAL top rankings are stable enough to cache for a few hours. Keyed by
// Jikan filter ("" = overall ranking, "airing" = topanime.php?type=airing).
const topCache = new Map(); // filter → { list, builtAt }
const TOP_TTL_MS = 6 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTopPage(page, filter) {
  const filterParam = filter ? `&filter=${encodeURIComponent(filter)}` : "";
  const url = `${JIKAN_API}/top/anime?page=${page}&limit=${PAGE_SIZE}${filterParam}`;
  debug(`MAL: top page ${page}${filter ? ` (${filter})` : ""}`);

  // One retry on 429: Jikan's limiter is bursty, so a short pause usually clears
  // it without us giving up the rest of the ranking.
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (res.ok) {
      const json = await res.json();
      return Array.isArray(json.data) ? json.data : [];
    }
    if (res.status === 429 && attempt === 0) {
      debug(`MAL: 429 on page ${page}, backing off ${RATE_LIMIT_BACKOFF_MS}ms`);
      await sleep(RATE_LIMIT_BACKOFF_MS);
      continue;
    }
    throw new Error(`Jikan top error: ${res.status}`);
  }
  return [];
}

// Return the top `maxPages * 25` MyAnimeList anime in rank order, as lightweight
// records ({ mal_id, title, rank }). `filter` selects the ranking: "" for the
// overall top, "airing" for currently-airing anime. Cached for TOP_TTL_MS.
async function getTopAnime(maxPages, filter = "") {
  const cached = topCache.get(filter);
  if (cached && Date.now() - cached.builtAt < TOP_TTL_MS) {
    return cached.list;
  }

  const list = [];
  for (let page = 1; page <= maxPages; page++) {
    let data;
    try {
      data = await fetchTopPage(page, filter);
    } catch (err) {
      debug(`MAL: stopping top walk at page ${page}: ${err.message}`);
      break;
    }
    if (data.length === 0) break;
    for (const a of data) {
      if (a.mal_id) list.push({ mal_id: a.mal_id, title: a.title, rank: a.rank });
    }
    if (data.length < PAGE_SIZE) break; // last page
    if (page < maxPages) await sleep(REQUEST_DELAY_MS);
  }

  topCache.set(filter, { list, builtAt: Date.now() });
  debug(`MAL: cached top ${list.length} anime${filter ? ` (${filter})` : ""}`);
  return list;
}

module.exports = { getTopAnime };
