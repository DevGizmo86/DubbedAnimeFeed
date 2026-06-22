const { addonBuilder } = require("stremio-addon-sdk");
const { getDubbedCatalog, searchDubbedCatalog } = require("./services/animeunity");
const { getKitsuMeta } = require("./services/kitsu");
const debug = require("./debug");

const CATALOG_ID = "au-dubbed-latest";
const SEARCH_CATALOG_ID = "au-dubbed-search";

const manifest = {
  id: "com.dubbedanime.feed-it",
  version: "1.1.0",
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
  catalogs: [
    {
      type: "anime",
      id: CATALOG_ID,
      name: "Ultime uscite doppiate ITA",
      extra: [{ name: "skip", isRequired: false }],
    },
    {
      // Search-only catalog: `search` is required, so Stremio never shows this
      // on the home board — it's queried only when the user runs a search.
      // Backed by AnimeUnity's full dubbed archive (not just the latest feed).
      type: "anime",
      id: SEARCH_CATALOG_ID,
      name: "Anime doppiati ITA",
      extra: [
        { name: "search", isRequired: true },
        { name: "skip", isRequired: false },
      ],
    },
  ],
  behaviorHints: {
    adult: false,
    p2p: false,
    configurable: false,
    configurationRequired: false,
  },
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  debug(`→ catalog request  type=${type}  id=${id}`, extra);

  // Stremio paginates by sending the number of items already loaded as `skip`.
  const skip = parseInt(extra && extra.skip, 10) || 0;

  let metas;
  if (id === SEARCH_CATALOG_ID) {
    const query = (extra && extra.search) || "";
    metas = await searchDubbedCatalog(query, skip);
  } else if (id === CATALOG_ID) {
    metas = await getDubbedCatalog(skip);
  } else {
    return { metas: [] };
  }

  debug(`← catalog response  ${metas.length} meta(s) (skip=${skip})`);
  return { metas };
});

builder.defineMetaHandler(async ({ type, id }) => {
  debug(`→ meta request  type=${type}  id=${id}`);

  // id is "kitsu:<numericId>" (our catalog items). Strip the prefix.
  const kitsuId = id.startsWith("kitsu:") ? id.slice("kitsu:".length) : null;
  if (!kitsuId) {
    return { meta: null };
  }

  try {
    const meta = await getKitsuMeta(kitsuId, type);
    debug(`← meta response  "${meta.name}"`);
    return { meta };
  } catch (err) {
    console.error(`Kitsu meta failed for ${id}:`, err.message);
    return { meta: null };
  }
});

module.exports = builder.getInterface();
