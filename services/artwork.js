const fetch = require("node-fetch");
const sharp = require("sharp");
const crypto = require("node:crypto");
const tmdb = require("./tmdb-artwork");

const PREFIX = "/artwork/landscape/";
const cache = new Map();
const pending = new Map();
const TTL = 6 * 60 * 60 * 1000;

function imageUrl(value) {
  try { return typeof value === "string" && new URL(value).protocol === "https:" ? value : null; }
  catch (_) { return null; }
}

async function kitsu(id, suffix = "?include=mappings") {
  const response = await fetch(`https://kitsu.io/api/edge/anime/${id}${suffix}`, { timeout: 5000 });
  if (!response.ok) throw new Error(`Kitsu artwork HTTP ${response.status}`);
  return response.json();
}

async function resolveLandscape(id, tmdbKey) {
  const json = await kitsu(id);
  if (String(json.data?.id) !== id) throw new Error("Kitsu artwork ID mismatch");
  const a = json.data.attributes || {};
  const mappings = (json.included || []).filter(m => m.type === "mappings").map(m => m.attributes || {});
  const mapping = site => mappings.find(m => m.externalSite === site)?.externalId;
  const isMovie = a.subtype === "movie";
  const direct = mapping(isMovie ? "themoviedb/movies" : "themoviedb/tv") || mapping(isMovie ? "themoviedb/movie" : "tmdb/tv");
  const url = await tmdb.getBackdrop(tmdbKey, {
    kitsuId: id, isMovie,
    tmdbId: /^\d+$/.test(String(direct)) ? direct : undefined,
    tvdbId: mapping("thetvdb/series"),
    imdbId: /^tt\d+$/.test(mapping("imdb") || "") ? mapping("imdb") : undefined,
    titles: [a.titles?.en, a.canonicalTitle, ...Object.values(a.titles || {})].filter(Boolean),
    year: a.startDate?.slice(0, 4),
  });
  if (url) return { url, primary: true };
  // Kitsu covers are genuinely horizontal artwork. Return the original URL,
  // without adding margins, blurring, or adapting any vertical poster.
  const cover = a.coverImage;
  const coverUrl = cover && imageUrl(cover.original || cover.large || cover.small);
  if (coverUrl) return { url: coverUrl, primary: false };
  const episodes = await kitsu(id, "/episodes?page%5Blimit%5D=5&sort=number");
  const still = (episodes.data || []).map(e => e.attributes?.thumbnail).filter(Boolean)
    .map(i => imageUrl(i.original || i.large || i.medium)).find(Boolean);
  return { url: still || null, primary: false };
}

async function getLandscapeUrl(id, tmdbKey = null) {
  if (!/^\d+$/.test(id)) throw new Error("Invalid Kitsu artwork ID");
  const credential = crypto.createHash("sha256").update(tmdbKey || "").digest("hex");
  const key = `${credential}:${id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.url;
  if (!pending.has(key)) {
    pending.set(key, resolveLandscape(id, tmdbKey).then(result => {
      if (result.url) {
        if (cache.size >= 1000) cache.delete(cache.keys().next().value);
        // Retry provider outages soon instead of locking an installation onto
        // fallback artwork for six hours after the API key is first installed.
        cache.set(key, { url: result.url, at: Date.now(), ttl: result.primary ? TTL : 60000 });
      }
      return result.url;
    }).finally(() => pending.delete(key)));
  }
  return pending.get(key);
}

async function landscapePreview(meta, tmdbKey = null) {
  const id = meta.id.match(/^kitsu:(\d+)$/)?.[1];
  if (!id) return { ...meta };
  let url = null;
  try { url = await getLandscapeUrl(id, tmdbKey); } catch (_) { /* No invented portrait fallback. */ }
  return { ...meta, poster: url || undefined, background: url || undefined, landscapePoster: url || undefined, posterShape: "landscape" };
}

async function landscapePage(metas, tmdbKey) {
  const output = new Array(metas.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, metas.length) }, async () => {
    while (next < metas.length) {
      const index = next++;
      output[index] = await landscapePreview(metas[index], tmdbKey);
    }
  }));
  return output;
}

// Legacy image URLs remain usable while installed clients refresh catalogs.
// New previews use the public CDN URL directly and never include API keys.
async function getLandscapeArtwork(id, type = "series") {
  if (!["series", "movie"].includes(type)) throw new Error("Invalid Kitsu artwork type");
  const url = await getLandscapeUrl(id, process.env.TMDB_API_KEY || null);
  if (!url) throw new Error("No landscape artwork available");
  const response = await fetch(url, { timeout: 5000, size: 10 * 1024 * 1024 });
  if (!response.ok) throw new Error(`Artwork HTTP ${response.status}`);
  const input = await response.buffer();
  const size = await sharp(input).metadata();
  if (!(size.width > size.height)) throw new Error("Landscape artwork is not horizontal");
  const body = await sharp(input).rotate().resize(960, 540, { fit: "cover" }).jpeg({ quality: 85 }).toBuffer();
  return { body };
}

// SDK callbacks have no request origin. Resolve only our local artwork paths
// in the HTTP adapter, leaving shared catalog data and other URLs untouched.
function absoluteArtwork(response, origin) {
  if (!response.metas) return response;
  return { ...response, metas: response.metas.map((meta) => {
    const result = { ...meta };
    for (const field of ["poster", "background"]) {
      if (meta[field]?.startsWith(PREFIX)) result[field] = new URL(meta[field], origin).href;
    }
    return result;
  }) };
}

function publicOrigin(req) {
  if (process.env.PUBLIC_URL) return new URL(process.env.PUBLIC_URL).origin;
  const forwardedHost = req.get("x-forwarded-host")?.split(",")[0].trim();
  let host = forwardedHost || req.get("host");
  let protocol = req.get("x-forwarded-proto")?.split(",")[0].trim() || req.protocol;
  // Beamup rewrites Host to its internal app name. That name resolves inside
  // the platform only; return the public hostname to Android/TV clients.
  if (/^[a-f0-9]{12}-[a-z0-9-]+$/i.test(host)) {
    host += ".baby-beamup.club";
    protocol = "https";
  }
  return `${protocol === "https" ? "https" : "http"}://${host}`;
}

module.exports = { landscapePreview, landscapePage, getLandscapeUrl, getLandscapeArtwork, absoluteArtwork, publicOrigin };
