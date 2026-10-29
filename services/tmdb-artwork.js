const fetch = require("node-fetch");
const crypto = require("node:crypto");

const cache = new Map();
const pending = new Map();
const TTL = 6 * 60 * 60 * 1000;
const norm = value => String(value || "").normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const image = path => /^\/[\w.-]+\.(jpg|png|webp)$/i.test(path || "") ? `https://image.tmdb.org/t/p/w1280${path}` : null;

async function get(key, path, params = {}) {
  const query = new URLSearchParams({ api_key: key, language: "it-IT", ...params });
  const response = await fetch(`https://api.themoviedb.org/3${path}?${query}`, { timeout: 5000 });
  // Do not propagate URLs containing the user's key into logs/errors.
  if (!response.ok) throw new Error(`TMDB artwork HTTP ${response.status}`);
  return response.json();
}

function pickBackdrop(images) {
  return (images || []).filter(i => {
    const ratio = Number(i.aspect_ratio) || Number(i.width) / Number(i.height);
    return image(i.file_path) && ratio >= 1.6 && ratio <= 1.95;
  }).sort((a, b) => {
    const language = i => i.iso_639_1 === "it" ? 0 : !i.iso_639_1 ? 1 : i.iso_639_1 === "en" ? 2 : 3;
    return language(a) - language(b) || (b.vote_average || 0) - (a.vote_average || 0) || (b.width || 0) - (a.width || 0);
  }).map(i => image(i.file_path))[0] || null;
}

async function resolve(key, info) {
  // Kitsu's actual subtype, not the catalog row, decides TV versus movie.
  // ONA/OVA anime such as Super Cube belong to TMDB's TV database.
  const type = info.isMovie ? "movie" : "tv";
  let id = info.tmdbId;
  for (const [external, source] of [[info.imdbId, "imdb_id"], [!info.isMovie && info.tvdbId, "tvdb_id"]]) {
    if (id || !external) continue;
    const found = await get(key, `/find/${external}`, { external_source: source });
    id = found[`${type}_results`]?.[0]?.id;
  }
  if (!id) {
    const titles = [...new Set((info.titles || []).filter(Boolean))].slice(0, 3);
    const wanted = new Set(titles.map(norm).filter(Boolean));
    for (const title of titles) {
      const params = { query: title };
      if (info.year) params[info.isMovie ? "year" : "first_air_date_year"] = info.year;
      const result = await get(key, `/search/${type}`, params);
      const match = (result.results || []).find(r => [r.name, r.original_name, r.title, r.original_title].some(t => t && wanted.has(norm(t))));
      if (match) { id = match.id; break; }
    }
  }
  if (!/^\d+$/.test(String(id))) return null;
  const images = await get(key, `/${type}/${id}/images`, { language: "", include_image_language: "it,null,en,ja,zh" });
  const backdrop = pickBackdrop(images.backdrops);
  if (backdrop) return backdrop;
  // A real episode still is a landscape alternative; never use a poster.
  if (type === "tv") {
    const episode = await get(key, `/tv/${id}/season/1/episode/1/images`, { language: "" });
    return pickBackdrop(episode.stills);
  }
  return null;
}

async function getBackdrop(key, info) {
  if (!key) return null;
  const credential = crypto.createHash("sha256").update(key).digest("hex");
  const cacheKey = `${credential}:${info.kitsuId}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL) return hit.url;
  if (!pending.has(cacheKey)) {
    pending.set(cacheKey, resolve(key, info).then(url => {
      if (url) {
        if (cache.size >= 1000) cache.delete(cache.keys().next().value);
        cache.set(cacheKey, { url, at: Date.now() });
      }
      return url;
    }).catch(() => null).finally(() => pending.delete(cacheKey)));
  }
  return pending.get(cacheKey);
}

module.exports = { getBackdrop, pickBackdrop };
