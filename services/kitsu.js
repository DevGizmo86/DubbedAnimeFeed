const fetch = require("node-fetch");
const debug = require("../debug");
const { getItalianMeta } = require("./animeunity");
const tmdb = require("./tmdb");

const KITSU_API = "https://kitsu.io/api/edge";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Follow Kitsu's episode pagination, with a safety limit for malformed feeds.
const EP_PAGE_SIZE = 20;
const MAX_EP_PAGES = 75; // up to 1,500 episodes with real metadata

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

// Fetch every available episode page. Kitsu's anime.episodeCount and the
// episodes collection can disagree, so keep both counts and the largest
// numbered episode. An interrupted page walk retains the data already read.
async function fetchEpisodes(kitsuId) {
  const byNumber = new Map();
  let collectionCount = 0;
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
    const count = parseInt(json.meta && json.meta.count, 10);
    if (Number.isFinite(count) && count > collectionCount) collectionCount = count;
    const data = Array.isArray(json.data) ? json.data : [];
    for (const e of data) {
      const a = e.attributes || {};
      const num = parseInt(a.number, 10);
      if (Number.isFinite(num) && num > 0) byNumber.set(num, a);
    }
    if (data.length < EP_PAGE_SIZE || (json.links && !json.links.next)) break;
  }
  return { byNumber, collectionCount };
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
      season: 1,
      episode: n,
      released: a && a.airdate ? new Date(a.airdate).toISOString() : undefined,
      thumbnail: a && a.thumbnail ? a.thumbnail.original || a.thumbnail.large : undefined,
      overview: a && a.synopsis ? a.synopsis : undefined,
    });
  }
  return videos;
}

// TheTVDB series id for a kitsu anime (from Kitsu's mappings), which lets TMDB
// resolve the show via an exact /find lookup. Cached per process; only fetched
// when a TMDB key is in play and the title is a series.
const tvdbCache = new Map(); // kitsuId → tvdbId | null
async function getTvdbId(kitsuId) {
  if (tvdbCache.has(kitsuId)) return tvdbCache.get(kitsuId);
  let tvdbId = null;
  try {
    const json = await kitsuGet(`/anime/${kitsuId}/mappings`);
    const m = (json.data || []).find(
      (x) => x.attributes && x.attributes.externalSite === "thetvdb/series"
    );
    if (m) tvdbId = m.attributes.externalId;
  } catch (err) {
    debug(`Kitsu mappings ${kitsuId} failed: ${err.message}`);
  }
  tvdbCache.set(kitsuId, tvdbId);
  return tvdbId;
}

// Overlay Italian title/synopsis/episode names on top of the (English) Kitsu
// meta. Priority: TMDB (when a key is configured) → AnimeUnity → Kitsu. Applied
// on every return — including cache hits — and cloned so the cached base meta
// stays untouched. `info` carries the bits TMDB needs to resolve the anime.
async function withItalian(base, info, kitsuId, tmdbKey) {
  let tmdbIt = null;
  if (tmdbKey) {
    try {
      const tvdbId = info.isMovie ? null : await getTvdbId(kitsuId);
      tmdbIt = await tmdb.getItalian(tmdbKey, {
        isMovie: info.isMovie,
        tvdbId,
        titles: info.titles,
        year: info.year,
      });
    } catch (err) {
      debug(`TMDB enrich ${kitsuId} failed: ${err.message}`);
    }
  }
  const au = getItalianMeta(kitsuId); // AnimeUnity Italian fallback

  const name = (tmdbIt && tmdbIt.name) || (au && au.name) || base.name;
  const description =
    (tmdbIt && tmdbIt.description) || (au && au.description) || base.description;
  const tmdbEpisodes = tmdbIt && tmdbIt.episodes && tmdbIt.episodes.length
    ? tmdbIt.episodes
    : null;

  if (name === base.name && description === base.description && !tmdbEpisodes) {
    return base;
  }

  const meta = { ...base, name, description };
  if (tmdbEpisodes && !info.isMovie) {
    const kitsuVideos = Array.isArray(base.videos) ? base.videos : [];
    const total = Math.max(kitsuVideos.length, tmdbEpisodes.length);
    meta.videos = Array.from({ length: total }, (_, i) => {
      const number = i + 1;
      const video = kitsuVideos[i] || {
        id: `kitsu:${kitsuId}:${number}`,
        title: `Episodio ${number}`,
        season: 1,
        episode: number,
      };
      const ep = tmdbEpisodes[i];
      return ep
        ? {
            ...video,
            title: ep.title || video.title,
            overview: ep.overview || video.overview,
            thumbnail: ep.thumbnail || video.thumbnail,
            released: video.released || ep.released,
          }
        : video;
    });
  }
  return meta;
}

// Build a full Stremio meta object for a kitsu anime id. `type` is echoed back
// from the request (our catalog uses "anime"). `tmdbKey` (optional) enables the
// richer Italian metadata from TMDB.
async function getKitsuMeta(kitsuId, type, tmdbKey) {
  const cached = metaCache.get(kitsuId);
  if (cached && Date.now() - cached.builtAt < META_TTL_MS) {
    return withItalian(cached.meta, cached.info, kitsuId, tmdbKey);
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
  const episodeData = isMovie ? null : await fetchEpisodes(kitsuId);
  const attributeCount = parseInt(a.episodeCount, 10);
  const numberedCount = episodeData && episodeData.byNumber.size
    ? Math.max(...episodeData.byNumber.keys())
    : 0;
  const total = isMovie ? 0 : Math.max(
    Number.isFinite(attributeCount) ? attributeCount : 0,
    episodeData.collectionCount,
    numberedCount
  );

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
    meta.videos = buildVideos(kitsuId, total, episodeData.byNumber);
  }

  // Bits TMDB needs to resolve this anime, stored so cache hits can enrich too.
  const info = {
    isMovie,
    year: startYear,
    titles: [
      a.canonicalTitle,
      a.titles && a.titles.en,
      a.titles && a.titles.en_jp,
      a.titles && a.titles.ja_jp,
    ].filter(Boolean),
  };

  metaCache.set(kitsuId, { meta, info, builtAt: Date.now() });
  debug(`getKitsuMeta: ${kitsuId} "${meta.name}" videos=${meta.videos ? meta.videos.length : 0}`);
  return withItalian(meta, info, kitsuId, tmdbKey);
}

module.exports = { getKitsuMeta };
