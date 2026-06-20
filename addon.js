const { addonBuilder } = require("stremio-addon-sdk");
const { getDubbedCatalog } = require("./services/animeunity");
const { getKitsuMeta } = require("./services/kitsu");
const debug = require("./debug");

const CATALOG_ID = "au-dubbed-latest";

const manifest = {
  id: "com.dubbedanime.feed-it",
  version: "1.0.0",
  name: "DubbedAnimeFeed",
  description:
    "Catalogo con le ultime uscite di anime doppiati in italiano (fonte AnimeUnity). Gli elementi usano id Kitsu, così gli addon di streaming anime possono fornire i video.",
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

  if (id !== CATALOG_ID) {
    return { metas: [] };
  }

  // Stremio paginates by sending the number of items already loaded as `skip`.
  // AnimeUnity's get-animes uses a record offset, so they line up 1:1.
  const skip = parseInt(extra && extra.skip, 10) || 0;

  const metas = await getDubbedCatalog(skip);

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
