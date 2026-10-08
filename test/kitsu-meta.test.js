const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
const fetch = async (url) => {
  const parsed = new URL(url);
  const id = parsed.pathname.match(/\/anime\/(\d+)/)?.[1];
  const isEpisodes = parsed.pathname.endsWith("/episodes");
  if (parsed.pathname.endsWith("/mappings")) {
    return { ok: true, json: async () => ({ data: [] }) };
  }
  if (!isEpisodes) {
    return {
      ok: true,
      json: async () => ({
        data: { attributes: {
          canonicalTitle: id === "999" ? "One Piece" : "Example",
          subtype: "TV",
          youtubeVideoId: "qgQunxD0qCk",
          episodeCount: id === "999" ? 280 : 3,
        } },
      }),
    };
  }
  const offset = Number(parsed.searchParams.get("page[offset]") || 0);
  const count = id === "999" ? 280 : 25;
  const size = id === "999" ? (offset === 0 ? 20 : 0) : Math.max(0, Math.min(20, 25 - offset));
  return {
    ok: true,
    json: async () => ({
      meta: { count },
      data: Array.from({ length: size }, (_, i) => ({
        attributes: {
          number: offset + i + 1,
          seasonNumber: i % 3 + 1,
          canonicalTitle: `Kitsu ${offset + i + 1}`,
          thumbnail: { original: `https://kitsu.example/${offset + i + 1}.jpg` },
        },
      })),
      links: { next: size === 20 ? "next" : null },
    }),
  };
};

Module._load = function (request, parent, isMain) {
  if (parent?.filename.endsWith("/services/kitsu.js")) {
    if (request === "node-fetch") return fetch;
    if (request === "./tmdb") return {
      getItalian: async () => ({
        name: "One Piece",
        cast: ["Test actor"],
        trailers: [{ source: "RH-FcW94z00", type: "Trailer", ytId: "RH-FcW94z00" }],
        episodes: Array.from({ length: 1205 }, (_, i) => ({
          title: `TMDB ${i + 1}`,
          thumbnail: `https://tmdb.example/${i + 1}.jpg`,
        })),
      }),
    };
    if (request === "./animeunity") return { getItalianMeta: () => null };
    if (request === "../debug") return () => {};
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { getKitsuMeta } = require("../services/kitsu");
Module._load = originalLoad;

test("Kitsu count and episode numbers stay intact in one season", async () => {
  const meta = await getKitsuMeta("888", "anime");
  assert.equal(meta.videos.length, 25);
  assert.equal(meta.videos[24].id, "kitsu:888:25");
  assert(meta.videos.every((video) => video.season === 1));
  assert.equal(meta.videos[20].thumbnail, "https://kitsu.example/21.jpg");
});

test("TMDB can extend a long Kitsu series and supply episode artwork", async () => {
  const meta = await getKitsuMeta("999", "anime", "sample-key");
  assert.equal(meta.videos.length, 1205);
  assert.deepEqual(meta.videos[1204], {
    id: "kitsu:999:1205",
    title: "TMDB 1205",
    season: 1,
    episode: 1205,
    overview: undefined,
    thumbnail: "https://tmdb.example/1205.jpg",
    released: undefined,
  });
  assert.equal(meta.videos[0].thumbnail, "https://tmdb.example/1.jpg");
  assert.equal(meta.videos[280].season, 1);
});


test("cached Kitsu metadata follows the requested type and includes its trailer", async () => {
  const legacy = await getKitsuMeta("888", "anime");
  const series = await getKitsuMeta("888", "series");
  assert.equal(legacy.type, "anime");
  assert.equal(series.type, "series");
  assert.equal(series.trailers[0].ytId, "qgQunxD0qCk");
  assert.equal(series.videos[0].id, "kitsu:888:1");
});

test("TMDB cast and trailers survive Italian metadata overlay", async () => {
  const meta = await getKitsuMeta("999", "series", "sample-key");
  assert.deepEqual(meta.cast, ["Test actor"]);
  assert.equal(meta.trailers[0].ytId, "RH-FcW94z00");
});

test("manifest uses standard catalog types while keeping legacy anime metadata", () => {
  const { manifest } = require("../addon");
  assert.deepEqual(manifest.types, ["series", "movie", "anime"]);
  assert(manifest.catalogs.every(c => c.type === (c.id.endsWith("movies") ? "movie" : "series")));
});
