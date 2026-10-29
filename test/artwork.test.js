const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const sharp = require("sharp");
const express = require("express");

function load(filename, mocks) {
  delete require.cache[filename];
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === filename && request in mocks) return mocks[request];
    return original.call(this, request, parent, isMain);
  };
  try { return require(filename); } finally { Module._load = original; }
}

const artworkFile = require.resolve("../services/artwork");
const meta = { id: "kitsu:55", type: "series", name: "Example", poster: "https://images.example/poster.jpg" };

test("all previews resolve by Kitsu ID even when source covers exist, without mutating shared data", () => {
  const art = load(artworkFile, {});
  const copy = { ...meta };
  assert.equal(art.landscapePreview(meta).poster, "/artwork/landscape/series/55.jpg?v=2");
  assert.deepEqual(meta, copy);
  assert.equal(art.landscapePreview({ ...meta, background: meta.poster }).poster, "/artwork/landscape/series/55.jpg?v=2");
  const resolved = art.landscapePreview({ ...meta, background: "https://images.example/cover.jpg" });
  assert.equal(resolved.poster, "/artwork/landscape/series/55.jpg?v=2");
  assert.equal(resolved.background, resolved.poster);
  assert.equal(art.landscapePreview({ ...meta, type: "movie" }).poster, "/artwork/landscape/movie/55.jpg?v=2");
});

test("Kitsu covers resolve by exact ID and concurrent image requests share a cached lookup", async () => {
  let calls = 0;
  const art = load(artworkFile, { "node-fetch": async (url) => {
    if (url.includes("easycatalogs")) throw new Error("offline");
    calls++;
    assert.equal(url, "https://kitsu.io/api/edge/anime/55");
    return { ok: true, json: async () => ({ data: { id: "55", attributes: { coverImage: { large: "https://images.example/cover.jpg" } } } }) };
  } });
  const result = await Promise.all([art.getLandscapeArtwork("55"), art.getLandscapeArtwork("55")]);
  assert.deepEqual(result, [{ redirect: "https://images.example/cover.jpg" }, { redirect: "https://images.example/cover.jpg" }]);
  await art.getLandscapeArtwork("55");
  assert.equal(calls, 1);
  await assert.rejects(art.getLandscapeArtwork("https://example.com"), /Invalid/);
});

test("EasyCatalogs background is preferred over its portrait poster, with exact ID and type and separate caches", async () => {
  const urls = [];
  const art = load(artworkFile, { "node-fetch": async (url) => {
    urls.push(url);
    const type = url.includes("/movie/") ? "movie" : "series";
    assert.equal(url, `https://easycatalogs.sonnysini.uk/meta/${type}/kitsu%3A55.json`);
    return { ok: true, json: async () => ({ meta: { id: "kitsu:55", type, poster: meta.poster, background: `https://image.tmdb.org/t/p/original/${type}.jpg` } }) };
  } });
  assert.deepEqual(await art.getLandscapeArtwork("55", "series"), { redirect: "https://image.tmdb.org/t/p/original/series.jpg" });
  assert.deepEqual(await art.getLandscapeArtwork("55", "movie"), { redirect: "https://image.tmdb.org/t/p/original/movie.jpg" });
  await art.getLandscapeArtwork("55", "series");
  assert.equal(urls.length, 2);
});

test("unrelated EasyCatalogs results, portrait backgrounds and invalid URLs fall back to original Kitsu cover", async () => {
  const wrong = [
    { id: "kitsu:99", type: "series", background: "https://images.example/wrong.jpg" },
    { id: "kitsu:55", type: "movie", background: "https://images.example/wrong.jpg" },
    { id: "kitsu:55", type: "series", background: meta.poster, poster: meta.poster },
    { id: "kitsu:55", type: "series", background: "file:///etc/passwd" },
  ];
  for (const bad of wrong) {
    const art = load(artworkFile, { "node-fetch": async (url) => ({ ok: true, json: async () => url.includes("easycatalogs")
      ? { meta: bad }
      : { data: { id: "55", attributes: { coverImage: { original: "https://images.example/original.jpg", large: "https://images.example/large.jpg" } } } } }) });
    assert.deepEqual(await art.getLandscapeArtwork("55"), { redirect: "https://images.example/original.jpg" });
  }
});

test("poster fallback keeps the top and bottom in a real 16:9 image, including during EasyCatalogs outages", async () => {
  const width = 60, height = 120;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3;
    pixels[offset + (y < height / 2 ? 0 : 2)] = 255;
  }
  const input = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
  for (const outage of [false, true]) {
    const art = load(artworkFile, { "node-fetch": async (url) => {
      if (url.includes("easycatalogs")) {
        if (outage) throw new Error("offline");
        return { ok: true, json: async () => ({ meta: { id: "kitsu:55", type: "series" } }) };
      }
      if (url.includes("kitsu.io")) return { ok: true, json: async () => ({ data: { id: "55", attributes: { posterImage: { original: meta.poster } } } }) };
      assert.equal(url, meta.poster);
      return { ok: true, buffer: async () => input };
    } });
    art.landscapePreview(meta);
    const { body } = await art.getLandscapeArtwork("55");
    const { data, info } = await sharp(body).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 640);
    assert.equal(info.height, 360);
    const pixel = (x, y, channel) => data[(y * 640 + x) * info.channels + channel];
    assert.ok(pixel(320, 10, 0) > 240, "top of poster retained");
    assert.ok(pixel(320, 350, 2) > 240, "bottom of poster retained");
    assert.ok(pixel(10, 180, 0) < 30, "side margin retained");
  }
});

test("failed image requests can recover and are not cached as successes", async () => {
  let offline = true;
  const art = load(artworkFile, { "node-fetch": async () => {
    if (offline) throw new Error("offline");
    return { ok: true, json: async () => ({ data: { id: "99", attributes: { coverImage: { large: "https://images.example/cover.jpg" } } } }) };
  } });
  await assert.rejects(art.getLandscapeArtwork("99"), /offline/);
  offline = false;
  assert.ok((await art.getLandscapeArtwork("99")).redirect);
});

test("all catalog handlers apply landscape artwork while portrait installations retain their original images", async () => {
  const art = load(artworkFile, {});
  const catalog = async () => [meta];
  const addon = load(require.resolve("../addon"), {
    "./services/artwork": art,
    "./services/animeunity": {
      getDubbedCatalog: catalog, searchDubbedCatalog: catalog,
      getTopDubbedCatalog: catalog, getTopAiringDubbedCatalog: catalog,
    },
  });
  for (const c of addon.manifest.catalogs) {
    const landscape = await addon.get("catalog", c.type, c.id, { search: "example" }, { posterOrientation: "landscape" });
    assert.equal(landscape.metas[0].poster, "/artwork/landscape/series/55.jpg?v=2");
    assert.equal(landscape.metas[0].posterShape, "landscape");
    assert.equal(landscape.metas[0].background, landscape.metas[0].poster);
    const portrait = await addon.get("catalog", c.type, c.id, { search: "example" }, { posterOrientation: "portrait" });
    assert.equal(portrait.metas[0].poster, meta.poster);
    assert.equal(portrait.metas[0].posterShape, "poster");
  }
});

test("HTTP catalogs use absolute HTTPS artwork URLs behind Beamup and the image route serves JPEG bytes", async (t) => {
  const app = express();
  const actualListen = app.listen.bind(app);
  app.listen = () => {};
  const jpeg = await sharp({ create: { width: 640, height: 360, channels: 3, background: "#171717" } }).jpeg().toBuffer();
  const art = load(artworkFile, {});
  const addon = {
    manifest: require("../addon").manifest,
    get: async () => ({ metas: [art.landscapePreview(meta)] }),
  };
  load(require.resolve("../index"), {
    express: Object.assign(() => app, { static: express.static }),
    "./addon": addon,
    "./services/artwork": { ...art, getLandscapeArtwork: async () => ({ body: jpeg }) },
  });
  const server = actualListen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/catalog/series/au-dubbed-latest-series.json`, { headers: { "x-forwarded-proto": "https" } });
  const json = await response.json();
  assert.equal(json.metas[0].poster, `${base.replace("http:", "https:")}/artwork/landscape/series/55.jpg?v=2`);
  assert.equal(json.metas[0].background, json.metas[0].poster);
  const image = await fetch(`${base}/artwork/landscape/series/55.jpg?v=2`);
  assert.match(image.headers.get("content-type"), /image\/jpeg/);
  assert.equal(image.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
  assert.equal((await fetch(`${base}/artwork/landscape/invalid.jpg`)).status, 404);
});
