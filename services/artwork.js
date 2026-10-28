const fetch = require("node-fetch");
const sharp = require("sharp");

const sources = new Map();
const cache = new Map();
const pending = new Map();
const TTL = 6 * 60 * 60 * 1000;
const PREFIX = "/artwork/landscape/";

function boundedSet(map, key, value, limit) {
  if (map.size >= limit) map.delete(map.keys().next().value);
  map.set(key, value);
}

function landscapePreview(meta) {
  // AnimeWorld supplies only portrait artwork. Never label that URL landscape:
  // clients use cover cropping and cut off most of the illustration.
  const cover = meta.background && meta.background !== meta.poster ? meta.background : null;
  const id = meta.id.match(/^kitsu:(\d+)$/)?.[1];
  if (cover) return { ...meta, poster: cover, posterShape: "landscape" };
  if (!id) return { ...meta, posterShape: "poster" };
  if (meta.poster) boundedSet(sources, id, meta.poster, 2000);
  return { ...meta, poster: `${PREFIX}${id}.jpg`, posterShape: "landscape" };
}

async function buildArtwork(id) {
  let poster = sources.get(id);
  try {
    const response = await fetch(`https://kitsu.io/api/edge/anime/${id}`, { timeout: 5000 });
    if (!response.ok) throw new Error(`Kitsu artwork HTTP ${response.status}`);
    const json = await response.json();
    if (String(json.data?.id) !== id) throw new Error("Kitsu artwork ID mismatch");
    const a = json.data.attributes || {};
    const cover = a.coverImage;
    const url = cover && (cover.large || cover.original || cover.small);
    if (url) return { redirect: url };
    const image = a.posterImage;
    poster = (image && (image.large || image.original || image.medium)) || poster;
  } catch (error) {
    // A temporary metadata outage can still use the catalog's original image.
    if (!poster) throw error;
  }
  if (!poster) throw new Error("No artwork available");
  const response = await fetch(poster, { timeout: 5000, size: 10 * 1024 * 1024 });
  if (!response.ok) throw new Error(`Poster HTTP ${response.status}`);
  const input = await response.buffer();
  // Contain preserves the whole poster, even if Nuvio forces every tile to 16:9.
  const body = await sharp(input, { limitInputPixels: 40000000 })
    .rotate()
    .resize(640, 360, { fit: "contain", background: "#171717" })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { body };
}

async function getLandscapeArtwork(id) {
  if (!/^\d+$/.test(id)) throw new Error("Invalid Kitsu artwork ID");
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  if (!pending.has(id)) {
    pending.set(id, buildArtwork(id).then((value) => {
      boundedSet(cache, id, { value, at: Date.now() }, 128);
      return value;
    }).finally(() => pending.delete(id)));
  }
  return pending.get(id);
}

// SDK callbacks have no request origin. Resolve only our local artwork paths
// in the HTTP adapter, leaving shared catalog data and other URLs untouched.
function absoluteArtwork(response, origin) {
  if (!response.metas) return response;
  return { ...response, metas: response.metas.map((meta) => (
    meta.poster?.startsWith(PREFIX)
      ? { ...meta, poster: new URL(meta.poster, origin).href }
      : meta
  )) };
}

module.exports = { landscapePreview, getLandscapeArtwork, absoluteArtwork };
