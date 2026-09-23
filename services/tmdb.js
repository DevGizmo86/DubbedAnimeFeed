const fetch = require("node-fetch");
const debug = require("../debug");

// TheMovieDB v3 REST API. We use it to pull Italian titles, synopses and
// episode names — TMDB's localization is far more complete than Kitsu's.
const TMDB_API = "https://api.themoviedb.org/3";
const LANG = "it-IT";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// TMDB data is identical for everyone — the API key is only an access
// credential, not a personalization — so every cache here is keyed by TMDB/TVDB
// id (or title+year), independent of which user's key triggered the fetch.
const idCache = new Map(); // lookup key → tmdbId | null
const detailCache = new Map(); // "tv:1429" / "movie:372058" → { name, description, seasons }
const episodeCache = new Map(); // tvId → flat ordered episode metadata
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function fresh(entry) {
  return entry && Date.now() - entry.builtAt < TTL_MS;
}

function norm(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function tmdbGet(key, path, params) {
  const usp = new URLSearchParams({ api_key: key, language: LANG, ...params });
  const res = await fetch(`${TMDB_API}${path}?${usp}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`TMDB ${path} → ${res.status}`);
  return res.json();
}

// Map a TheTVDB series id (from Kitsu's mappings) to a TMDB tv id via /find.
// This is an exact mapping, so it's much more reliable than a title search.
async function findTvByTvdb(key, tvdbId) {
  const ck = `tv:tvdb:${tvdbId}`;
  const cached = idCache.get(ck);
  if (fresh(cached)) return cached.id;

  let id = null;
  try {
    const j = await tmdbGet(key, `/find/${tvdbId}`, { external_source: "tvdb_id" });
    id = (j.tv_results && j.tv_results[0] && j.tv_results[0].id) || null;
  } catch (err) {
    debug(`TMDB find tvdb ${tvdbId} failed: ${err.message}`);
  }
  idCache.set(ck, { id, builtAt: Date.now() });
  return id;
}

// Fallback mapping: search TMDB (tv or movie) by candidate titles + year and
// keep the best match (exact normalized title, else the first result).
async function searchId(key, isMovie, titles, year) {
  const ck = `${isMovie ? "movie" : "tv"}:${norm(titles[0])}|${year || ""}`;
  const cached = idCache.get(ck);
  if (fresh(cached)) return cached.id;

  const path = isMovie ? "/search/movie" : "/search/tv";
  const yearParam = isMovie ? "year" : "first_air_date_year";

  let best = null;
  for (const title of titles) {
    if (!title) continue;
    let results;
    try {
      const params = { query: title };
      if (year) params[yearParam] = year;
      const j = await tmdbGet(key, path, params);
      results = j.results || [];
    } catch (err) {
      debug(`TMDB search "${title}" failed: ${err.message}`);
      continue;
    }
    if (!results.length) continue;
    const wanted = norm(title);
    best =
      results.find(
        (r) => norm(r.title || r.name || r.original_title || r.original_name) === wanted
      ) || results[0];
    if (best) break;
  }

  const id = best ? best.id : null;
  idCache.set(ck, { id, builtAt: Date.now() });
  return id;
}

// Italian title + overview (+ season list for tv) for a resolved TMDB id.
async function getDetail(key, isMovie, tmdbId) {
  const ck = `${isMovie ? "movie" : "tv"}:${tmdbId}`;
  const cached = detailCache.get(ck);
  if (fresh(cached)) return cached.value;

  let value = null;
  try {
    const j = await tmdbGet(key, `/${isMovie ? "movie" : "tv"}/${tmdbId}`, {});
    value = {
      name: (isMovie ? j.title : j.name) || undefined,
      description: j.overview || undefined,
      seasons: !isMovie && Array.isArray(j.seasons) ? j.seasons : [],
    };
  } catch (err) {
    debug(`TMDB detail ${ck} failed: ${err.message}`);
  }
  detailCache.set(ck, { value, builtAt: Date.now() });
  return value;
}

// Flat ordered Italian episode list across seasons 1..N (season 0 / specials
// skipped), so it aligns with our absolute episode numbering.
async function getEpisodes(key, tvId, seasons) {
  const cached = episodeCache.get(tvId);
  if (fresh(cached)) return cached.list;

  const realSeasons = (seasons || [])
    .filter((s) => s.season_number > 0)
    .sort((a, b) => a.season_number - b.season_number);

  const list = [];
  for (const s of realSeasons) {
    try {
      const j = await tmdbGet(key, `/tv/${tvId}/season/${s.season_number}`, {});
      const eps = (j.episodes || []).sort((a, b) => a.episode_number - b.episode_number);
      for (const e of eps) {
        list.push({
          title: e.name || undefined,
          overview: e.overview || undefined,
          thumbnail: e.still_path ? `https://image.tmdb.org/t/p/w500${e.still_path}` : undefined,
          released: e.air_date ? new Date(e.air_date).toISOString() : undefined,
        });
      }
    } catch (err) {
      debug(`TMDB season ${tvId}/${s.season_number} failed: ${err.message}`);
    }
  }
  episodeCache.set(tvId, { list, builtAt: Date.now() });
  return list;
}

// Lightweight lookup for catalog previews: Italian title + synopsis via a
// title+year search only (no TVDB mapping, no episode fetch), so it stays cheap
// enough to run across a whole catalog page. Returns null when unmatched.
async function getItalianBasic(key, { isMovie, titles, year }) {
  if (!key) return null;
  const tmdbId = await searchId(key, isMovie, titles || [], year);
  if (!tmdbId) return null;
  const detail = await getDetail(key, isMovie, tmdbId);
  if (!detail) return null;
  return { name: detail.name, description: detail.description };
}

// Resolve an anime to TMDB and return its Italian metadata, or null when no key
// is provided or no match is found. `tvdbId` (series only) enables the exact
// mapping; otherwise we fall back to a title+year search.
async function getItalian(key, { isMovie, tvdbId, titles, year }) {
  if (!key) return null;

  let tmdbId = null;
  if (!isMovie && tvdbId) tmdbId = await findTvByTvdb(key, tvdbId);
  if (!tmdbId) tmdbId = await searchId(key, isMovie, titles || [], year);
  if (!tmdbId) return null;

  const detail = await getDetail(key, isMovie, tmdbId);
  if (!detail) return null;

  const episodes = isMovie ? [] : await getEpisodes(key, tmdbId, detail.seasons);
  return { name: detail.name, description: detail.description, episodes };
}

module.exports = { getItalian, getItalianBasic };
