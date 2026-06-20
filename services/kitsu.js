const fetch = require("node-fetch");
const debug = require("../debug");

const KITSU_API = "https://kitsu.io/api/edge";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Stop fetching real episode pages after this many (20 each): for very long
// series we fall back to synthesizing the remaining entries from episodeCount,
// keeping the meta response bounded.
const EP_PAGE_SIZE = 20;
const MAX_EP_PAGES = 12; // up to 240 episodes with real metadata

// Built meta objects are cached per id: episode lists rarely change and this
// keeps repeated opens instant. Ongoing shows still refresh within the TTL.
const metaCache = new Map(); // kitsuId → { meta, builtAt }
const META_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function kitsuGet(pathAndQuery) {
  const res = await fetch(`${KITSU_API}${pathAndQuery}`, {
    headers: { "User-Agent": UA, Accept: "application/vnd.api+json" },
  });
  if (!res.ok) throw new Error(`Kitsu API ${pathAndQuery} → ${res.status}`);
  return res.json();
}

// Kitsu averageRating is 0–100; Stremio shows it like an IMDb rating (0–10).
function toRating10(avg) {
  const n = parseFloat(avg);
  if (!Number.isFinite(n)) return undefined;
  return (n / 10).toFixed(1);
}

function yearOf(date) {
  return date ? String(date).slice(0, 4) : undefined;
}

function pickPoster(img) {
  if (!img) return undefined;
  return img.medium || img.large || img.original || img.small || undefined;
}

function pickCover(img) {
  if (!img) return undefined;
  return img.large || img.original || img.medium || undefined;
}

// Fetch real episode metadata (number/title/airdate/thumbnail), paginated and
// capped. Returns a Map number → episode attributes.
// Total episode count. Ongoing/long series often have a null episodeCount on
// the anime record, so fall back to the episodes endpoint's meta.count.
async function getEpisodeCount(kitsuId, episodeCountAttr) {
  const fromAttr = parseInt(episodeCountAttr, 10);
  if (Number.isFinite(fromAttr) && fromAttr > 0) return fromAttr;
  try {
    const json = await kitsuGet(`/anime/${kitsuId}/episodes?page%5Blimit%5D=1`);
    const count = json.meta && parseInt(json.meta.count, 10);
    return Number.isFinite(count) ? count : 0;
  } catch (err) {
    debug(`Kitsu episode count ${kitsuId} failed: ${err.message}`);
    return 0;
  }
}

async function fetchEpisodes(kitsuId) {
  const byNumber = new Map();
  for (let page = 0; page < MAX_EP_PAGES; page++) {
    const offset = page * EP_PAGE_SIZE;
    let json;
    try {
      json = await kitsuGet(
        `/anime/${kitsuId}/episodes?page%5Blimit%5D=${EP_PAGE_SIZE}` +
          `&page%5Boffset%5D=${offset}&sort=number`
      );
    } catch (err) {
      debug(`Kitsu episodes ${kitsuId} page ${page} failed: ${err.message}`);
      break;
    }
    const data = json.data || [];
    for (const e of data) {
      const a = e.attributes || {};
      const num = parseInt(a.number, 10);
      if (Number.isFinite(num)) byNumber.set(num, a);
    }
    if (data.length < EP_PAGE_SIZE) break; // last page
  }
  return byNumber;
}

// Build the Stremio `videos` array. Episode video ids use the kitsu format
// `kitsu:<animeId>:<episode>` — the same shape the anime stream addons expect,
// so they can attach sources to each episode.
function buildVideos(kitsuId, total, realEpisodes) {
  const videos = [];
  for (let n = 1; n <= total; n++) {
    const a = realEpisodes.get(n);
    const title =
      (a && (a.canonicalTitle || (a.titles && (a.titles.en || a.titles.en_jp)))) ||
      `Episodio ${n}`;
    videos.push({
      id: `kitsu:${kitsuId}:${n}`,
      title,
      season: a && Number.isFinite(parseInt(a.seasonNumber, 10)) ? parseInt(a.seasonNumber, 10) : 1,
      episode: n,
      released: a && a.airdate ? new Date(a.airdate).toISOString() : undefined,
      thumbnail: a && a.thumbnail ? a.thumbnail.original || a.thumbnail.large : undefined,
      overview: a && a.synopsis ? a.synopsis : undefined,
    });
  }
  return videos;
}

// Build a full Stremio meta object for a kitsu anime id. `type` is echoed back
// from the request (our catalog uses "anime").
async function getKitsuMeta(kitsuId, type) {
  const cached = metaCache.get(kitsuId);
  if (cached && Date.now() - cached.builtAt < META_TTL_MS) {
    return cached.meta;
  }

  const json = await kitsuGet(`/anime/${kitsuId}?include=categories`);
  const a = json.data && json.data.attributes;
  if (!a) throw new Error(`Kitsu anime ${kitsuId} has no attributes`);

  const genres = (json.included || [])
    .filter((x) => x.type === "categories")
    .map((x) => x.attributes && x.attributes.title)
    .filter(Boolean)
    .slice(0, 8);

  const isMovie = a.subtype === "movie";
  const total = isMovie ? 0 : await getEpisodeCount(kitsuId, a.episodeCount);

  const startYear = yearOf(a.startDate);
  const endYear = yearOf(a.endDate);

  const meta = {
    id: `kitsu:${kitsuId}`,
    type,
    name: a.canonicalTitle || (a.titles && a.titles.en) || "Anime",
    poster: pickPoster(a.posterImage),
    posterShape: "poster",
    background: pickCover(a.coverImage),
    description: a.synopsis || a.description || undefined,
    releaseInfo: endYear && endYear !== startYear ? `${startYear}-${endYear}` : startYear,
    imdbRating: toRating10(a.averageRating),
    genres: genres.length ? genres : undefined,
    runtime: a.episodeLength ? `${a.episodeLength} min` : undefined,
  };

  // Series: attach an episode list. Movies / single-episode entries stay flat.
  if (!isMovie && total > 1) {
    const realEpisodes = await fetchEpisodes(kitsuId);
    meta.videos = buildVideos(kitsuId, total, realEpisodes);
  }

  metaCache.set(kitsuId, { meta, builtAt: Date.now() });
  debug(`getKitsuMeta: ${kitsuId} "${meta.name}" videos=${meta.videos ? meta.videos.length : 0}`);
  return meta;
}

module.exports = { getKitsuMeta };
