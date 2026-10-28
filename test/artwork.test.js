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

test("missing covers use a local horizontal image while existing covers and shared previews remain intact", () => {
  const art = load(artworkFile, {});
  const copy = { ...meta };
  assert.equal(art.landscapePreview(meta).poster, "/artwork/landscape/55.jpg");
  assert.deepEqual(meta, copy);
  assert.equal(art.landscapePreview({ ...meta, background: meta.poster }).poster, "/artwork/landscape/55.jpg");
  assert.equal(art.landscapePreview({ ...meta, background: "https://images.example/cover.jpg" }).poster, "https://images.example/cover.jpg");
});

test("Kitsu covers resolve by exact ID and concurrent image requests share a cached lookup", async () => {
  let calls = 0;
  const art = load(artworkFile, { "node-fetch": async (url) => {
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

test("poster fallback keeps the top and bottom in a real 16:9 image, including during Kitsu outages", async () => {
  const width = 60, height = 120;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3;
    pixels[offset + (y < height / 2 ? 0 : 2)] = 255;
  }
  const input = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
  for (const outage of [false, true]) {
    const art = load(artworkFile, { "node-fetch": async (url) => {
      if (url.includes("kitsu.io")) {
        if (outage) throw new Error("offline");
        return { ok: true, json: async () => ({ data: { id: "55", attributes: {} } }) };
      }
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
    assert.equal(landscape.metas[0].poster, "/artwork/landscape/55.jpg");
    assert.equal(landscape.metas[0].posterShape, "landscape");
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
  assert.equal(json.metas[0].poster, `${base.replace("http:", "https:")}/artwork/landscape/55.jpg`);
  const image = await fetch(`${base}/artwork/landscape/55.jpg`);
  assert.match(image.headers.get("content-type"), /image\/jpeg/);
  assert.equal(image.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
  assert.equal((await fetch(`${base}/artwork/landscape/invalid.jpg`)).status, 404);
});
