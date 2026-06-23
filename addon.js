const { addonBuilder } = require("stremio-addon-sdk");
const {
  getDubbedCatalog,
  searchDubbedCatalog,
  getTopDubbedCatalog,
} = require("./services/animeunity");
const { getKitsuMeta } = require("./services/kitsu");
const debug = require("./debug");

// Latest dubbed releases, split into series and movies.
const LATEST_SERIES_ID = "au-dubbed-latest-series";
const LATEST_MOVIES_ID = "au-dubbed-latest-movies";
// MAL top ranking ∩ dubbed archive, split into series and movies.
const TOP_SERIES_ID = "mal-top-dubbed-series";
const TOP_MOVIES_ID = "mal-top-dubbed-movies";
// Search-only catalogs over the full dubbed archive, split into series/movies.
const SEARCH_SERIES_ID = "au-dubbed-search-series";
const SEARCH_MOVIES_ID = "au-dubbed-search-movies";

const manifest = {
  id: "com.dubbedanime.feed-it",
  version: "1.4.0",
  name: "DubbedAnimeFeed",
  description:
    "Catalogo con le ultime uscite di anime doppiati in italiano e ricerca di tutti gli anime doppiati in italiano disponibili in streaming.",
  logo: "https://i.imgur.com/M8Th3g0.png",
  // Served as a static file by Express (see index.js). Root-relative so it
  // works on any host without bloating the manifest past the 8kb limit.
  background: "/assets/background.png",
  resources: ["catalog", "meta"],
  types: ["anime"],
  idPrefixes: ["kitsu:"],
  // Optional user configuration: a TMDB API key. When provided, titles,
  // synopses and episode names are fetched from TMDB in Italian; without it the
  // addon still works, falling back to AnimeUnity's Italian text + Kitsu.
  config: [
    {
      key: "tmdbKey",
      type: "text",
      title:
        "Chiave API TMDB (opzionale) — per titoli, trame ed episodi in italiano",
    },
  ],
  catalogs: [
    {
      type: "anime",
      id: LATEST_SERIES_ID,
      name: "Ultime serie doppiate ITA",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      type: "anime",
      id: LATEST_MOVIES_ID,
      name: "Ultimi film doppiati ITA",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      // Home board catalog: MyAnimeList's top ranking filtered to the anime
      // that are available dubbed in Italian on AnimeUnity, in MAL rank order.
      type: "anime",
      id: TOP_SERIES_ID,
      name: "Top serie anime ITA",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      type: "anime",
      id: TOP_MOVIES_ID,
      name: "Top film anime ITA",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      // Search-only catalog: `search` is required, so Stremio never shows this
      // on the home board — it's queried only when the user runs a search.
      // Backed by AnimeUnity's full dubbed archive (not just the latest feed).
      type: "anime",
      id: SEARCH_SERIES_ID,
      name: "Serie anime doppiate ITA",
      extra: [
        { name: "search", isRequired: true },
        { name: "skip", isRequired: false },
      ],
    },
    {
      type: "anime",
      id: SEARCH_MOVIES_ID,
      name: "Film anime doppiati ITA",
      extra: [
        { name: "search", isRequired: true },
        { name: "skip", isRequired: false },
      ],
    },
  ],
  behaviorHints: {
    adult: false,
    p2p: false,
    configurable: true,
    configurationRequired: false,
  },
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  debug(`→ catalog request  type=${type}  id=${id}`, extra);

  // Stremio paginates by sending the number of items already loaded as `skip`.
  const skip = parseInt(extra && extra.skip, 10) || 0;

  let metas;
  if (id === SEARCH_SERIES_ID || id === SEARCH_MOVIES_ID) {
    const query = (extra && extra.search) || "";
    const kind = id === SEARCH_MOVIES_ID ? "movie" : "series";
    metas = await searchDubbedCatalog(query, kind, skip);
  } else if (id === TOP_SERIES_ID || id === TOP_MOVIES_ID) {
    const kind = id === TOP_MOVIES_ID ? "movie" : "series";
    metas = await getTopDubbedCatalog(kind, skip);
  } else if (id === LATEST_SERIES_ID || id === LATEST_MOVIES_ID) {
    const kind = id === LATEST_MOVIES_ID ? "movie" : "series";
    metas = await getDubbedCatalog(kind, skip);
  } else {
    return { metas: [] };
  }

  debug(`← catalog response  ${metas.length} meta(s) (skip=${skip})`);
  return { metas };
});

builder.defineMetaHandler(async ({ type, id, config }) => {
  debug(`→ meta request  type=${type}  id=${id}`);

  // id is "kitsu:<numericId>" (our catalog items). Strip the prefix.
  const kitsuId = id.startsWith("kitsu:") ? id.slice("kitsu:".length) : null;
  if (!kitsuId) {
    return { meta: null };
  }

  // TMDB key from the user's addon configuration, falling back to an env var
  // for local development.
  const tmdbKey = (config && config.tmdbKey) || process.env.TMDB_API_KEY || null;

  try {
    const meta = await getKitsuMeta(kitsuId, type, tmdbKey);
    debug(`← meta response  "${meta.name}"`);
    return { meta };
  } catch (err) {
    console.error(`Kitsu meta failed for ${id}:`, err.message);
    return { meta: null };
  }
});

module.exports = builder.getInterface();
