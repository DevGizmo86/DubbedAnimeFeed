const fetch = require("node-fetch");
const debug = require("../debug");

// Jikan is the public REST API over MyAnimeList. /top/anime returns the same
// ranking as https://myanimelist.net/topanime.php but as clean JSON, so we
// avoid scraping the (fragile) HTML page.
const JIKAN_API = "https://api.jikan.moe/v4";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 12000;
const MAL_PAGE_SIZE = 50;
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
      timeout: REQUEST_TIMEOUT_MS,
    });
    if (res.ok) {
      const json = await res.json();
      if (!Array.isArray(json.data)) throw new Error("Invalid Jikan top response");
      return json.data;
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
async function loadJikanTop(maxPages, filter = "") {
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
      console.error(`MAL top failed at page ${page}: ${err.message}`);
      throw err;
    }
    if (data.length === 0) break;
    for (const a of data) {
      if (a.mal_id) list.push({ mal_id: a.mal_id, title: a.title, rank: a.rank });
    }
    if (data.length < PAGE_SIZE) break; // last page
    if (page < maxPages) await sleep(REQUEST_DELAY_MS);
  }

  if (!list.length) throw new Error("Jikan top ranking is empty");
  topCache.set(filter, { list, builtAt: Date.now() });
  debug(`MAL: cached top ${list.length} anime${filter ? ` (${filter})` : ""}`);
  return list;
}

// Use the same MAL ranking directly when the public Jikan instance fails.
// Only ranking rows count; challenge/error pages must never become empty data.
function parseMalRanking(html) {
  const rows = html.match(/<tr\b[^>]*class="[^"]*\branking-list\b[^"]*"[^>]*>[\s\S]*?<\/tr>/gi) || [];
  return rows.map((row) => {
    const id = row.match(/href="https:\/\/myanimelist\.net\/anime\/(\d+)\//);
    const rank = row.match(/class="[^"]*top-anime-rank-text[^\"]*"[^>]*>\s*(\d+|-)/);
    const title = row.match(/<h3\b[^>]*>[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/);
    if (!id || !rank) throw new Error("Invalid MyAnimeList ranking row");
    return { mal_id: Number(id[1]), rank: rank[1] === "-" ? null : Number(rank[1]), title: title ? title[1].replace(/<[^>]+>/g, "").trim() : "" };
  });
}

async function loadMalTop(maxPages, filter) {
  const list = [];
  const target = maxPages * PAGE_SIZE;
  for (let offset = 0; offset < target; offset += MAL_PAGE_SIZE) {
    const type = filter ? `type=${encodeURIComponent(filter)}&` : "";
    const res = await fetch(`https://myanimelist.net/topanime.php?${type}limit=${offset}`, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      timeout: REQUEST_TIMEOUT_MS,
    });
    const html = await res.text();
    // MAL returns its own 404 page for an offset past the ranking end.
    if (res.status === 404 && list.length && /404 Not Found - MyAnimeList\.net/.test(html)) break;
    if (!res.ok) throw new Error(`MyAnimeList top error: ${res.status}`);
    const page = parseMalRanking(html);
    if (!page.length) {
      if (list.length && /No anime found/i.test(html)) break;
      throw new Error("MyAnimeList ranking unavailable or unrecognized");
    }
    list.push(...page);
    // A full final page can contain unranked entries (rank "-").
    // Follow the actual pagination rather than probing another empty offset.
    const hasNext = /<link\b[^>]*rel="next"[^>]*>/i.test(html) || /<a\b[^>]*class="[^"]*\bnext\b[^"]*"[^>]*>/i.test(html);
    if (page.length < MAL_PAGE_SIZE || !hasNext) break;
    if (offset + MAL_PAGE_SIZE < target) await sleep(REQUEST_DELAY_MS);
  }
  const result = list.slice(0, target);
  topCache.set(filter, { list: result, builtAt: Date.now() });
  return result;
}

const pending = new Map();
function getTopAnime(maxPages, filter = "") {
  const cached = topCache.get(filter);
  if (cached && Date.now() - cached.builtAt < TOP_TTL_MS) return Promise.resolve(cached.list);
  if (!pending.has(filter)) {
    pending.set(filter, loadJikanTop(maxPages, filter).catch(async (err) => {
      console.error(`Jikan unavailable; trying MyAnimeList directly: ${err.message}`);
      try { return await loadMalTop(maxPages, filter); }
      catch (fallbackError) {
        if (cached) return cached.list;
        throw fallbackError;
      }
    }).finally(() => pending.delete(filter)));
  }
  return pending.get(filter);
}

module.exports = { getTopAnime, parseMalRanking };
