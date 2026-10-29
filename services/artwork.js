const fetch = require("node-fetch");
const sharp = require("sharp");

const cache = new Map();
const pending = new Map();
const TTL = 6 * 60 * 60 * 1000;
const PREFIX = "/artwork/landscape/";

function boundedSet(map, key, value, limit) {
  if (map.size >= limit) map.delete(map.keys().next().value);
  map.set(key, value);
}

function landscapePreview(meta) {
  // Always resolve artwork by identity. Source "covers" are not necessarily
  // landscape; accepting them here bypassed the resolver in v1.5.11.
  const id = meta.id.match(/^kitsu:(\d+)$/)?.[1];
  if (!id) return { ...meta, posterShape: "poster" };
  const type = meta.type === "movie" ? "movie" : "series";
  const url = `${PREFIX}${type}/${id}.jpg?v=3`;
  // Landscape clients may read background instead of poster. Keep them aligned
  // and version the URL to avoid reusing the previous cropped image cache.
  return { ...meta, poster: url, background: url, posterShape: "landscape" };
}

function imageUrl(value) {
  try { return typeof value === "string" && new URL(value).protocol === "https:" ? value : null; }
  catch (_) { return null; }
}

async function renderArtwork(url) {
  const response = await fetch(url, { timeout: 5000, size: 10 * 1024 * 1024 });
  if (!response.ok) throw new Error(`Artwork HTTP ${response.status}`);
  const input = await response.buffer();
  // Kitsu covers can be very wide banners. Always contain the full image in
  // 16:9, so the client's cover fitting cannot crop either banners or posters.
  const body = await sharp(input, { limitInputPixels: 40000000 })
    .rotate()
    .resize(960, 540, { fit: "contain", background: "#171717" })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { body };
}

async function buildArtwork(id, type) {
  // EasyCatalogs exposes a separate TMDB background for exact Kitsu IDs,
  // whereas its poster is portrait. No title search or user API key is needed.
  try {
    const response = await fetch(`https://easycatalogs.sonnysini.uk/meta/${type}/${encodeURIComponent(`kitsu:${id}`)}.json`, { timeout: 5000 });
    if (!response.ok) throw new Error(`EasyCatalogs artwork HTTP ${response.status}`);
    const json = await response.json();
    const meta = json.meta;
    if (meta?.id === `kitsu:${id}` && meta.type === type && meta.background !== meta.poster) {
      const background = imageUrl(meta.background);
      if (background) return await renderArtwork(background);
    }
  } catch (_) { /* Fall back to Kitsu's own artwork for this exact ID. */ }
  const responseMeta = await fetch(`https://kitsu.io/api/edge/anime/${id}`, { timeout: 5000 });
  if (!responseMeta.ok) throw new Error(`Kitsu artwork HTTP ${responseMeta.status}`);
  const json = await responseMeta.json();
  if (String(json.data?.id) !== id) throw new Error("Kitsu artwork ID mismatch");
  const a = json.data.attributes || {};
  const cover = a.coverImage;
  const url = cover && imageUrl(cover.original || cover.large || cover.small);
  if (url) {
    try { return await renderArtwork(url); }
    catch (_) { /* Missing/corrupt cover: try this same anime's poster. */ }
  }
  const image = a.posterImage;
  const poster = image && imageUrl(image.original || image.large || image.medium);
  if (!poster) throw new Error("No artwork available");
  return renderArtwork(poster);
}

async function getLandscapeArtwork(id, type = "series") {
  if (!/^\d+$/.test(id) || !["series", "movie"].includes(type)) throw new Error("Invalid Kitsu artwork ID or type");
  const key = `${type}:${id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  if (!pending.has(key)) {
    pending.set(key, buildArtwork(id, type).then((value) => {
      boundedSet(cache, key, { value, at: Date.now() }, 128);
      return value;
    }).finally(() => pending.delete(key)));
  }
  return pending.get(key);
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

module.exports = { landscapePreview, getLandscapeArtwork, absoluteArtwork, publicOrigin };
