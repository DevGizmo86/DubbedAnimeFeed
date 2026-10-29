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
const sampleImage = sharp({ create: { width: 160, height: 90, channels: 3, background: "red" } }).png().toBuffer();
const asset = () => ({ ok: true, buffer: () => sampleImage });
const meta = { id: "kitsu:55", type: "series", name: "Example", poster: "https://images.example/poster.jpg" };

test("all previews resolve by Kitsu ID even when source covers exist, without mutating shared data", () => {
  const art = load(artworkFile, {});
  const copy = { ...meta };
  assert.equal(art.landscapePreview(meta).poster, "/artwork/landscape/series/55.jpg?v=3");
  assert.deepEqual(meta, copy);
  assert.equal(art.landscapePreview({ ...meta, background: meta.poster }).poster, "/artwork/landscape/series/55.jpg?v=3");
  const resolved = art.landscapePreview({ ...meta, background: "https://images.example/cover.jpg" });
  assert.equal(resolved.poster, "/artwork/landscape/series/55.jpg?v=3");
  assert.equal(resolved.background, resolved.poster);
  assert.equal(art.landscapePreview({ ...meta, type: "movie" }).poster, "/artwork/landscape/movie/55.jpg?v=3");
});

test("Kitsu covers resolve by exact ID and concurrent image requests share a cached lookup", async () => {
  let calls = 0;
  const art = load(artworkFile, { "node-fetch": async (url) => {
    if (url.includes("easycatalogs")) throw new Error("offline");
    if (url === "https://images.example/cover.jpg") return asset();
    calls++;
    assert.equal(url, "https://kitsu.io/api/edge/anime/55");
    return { ok: true, json: async () => ({ data: { id: "55", attributes: { coverImage: { large: "https://images.example/cover.jpg" } } } }) };
  } });
  const result = await Promise.all([art.getLandscapeArtwork("55"), art.getLandscapeArtwork("55")]);
  assert.ok(result[0].body.length > 0);
  assert.equal(result[0], result[1]);
  await art.getLandscapeArtwork("55");
  assert.equal(calls, 1);
  await assert.rejects(art.getLandscapeArtwork("https://example.com"), /Invalid/);
});

test("EasyCatalogs background is preferred over its portrait poster, with exact ID and type and separate caches", async () => {
  const urls = [];
  const art = load(artworkFile, { "node-fetch": async (url) => {
    if (url.startsWith("https://image.tmdb.org/")) return asset();
    urls.push(url);
    const type = url.includes("/movie/") ? "movie" : "series";
    assert.equal(url, `https://easycatalogs.sonnysini.uk/meta/${type}/kitsu%3A55.json`);
    return { ok: true, json: async () => ({ meta: { id: "kitsu:55", type, poster: meta.poster, background: `https://image.tmdb.org/t/p/original/${type}.jpg` } }) };
  } });
  assert.ok((await art.getLandscapeArtwork("55", "series")).body.length > 0);
  assert.ok((await art.getLandscapeArtwork("55", "movie")).body.length > 0);
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
    const art = load(artworkFile, { "node-fetch": async (url) => {
      if (url.startsWith("https://images.example/")) {
        assert.equal(url, "https://images.example/original.jpg");
        return asset();
      }
      return { ok: true, json: async () => url.includes("easycatalogs")
        ? { meta: bad }
        : { data: { id: "55", attributes: { coverImage: { original: "https://images.example/original.jpg", large: "https://images.example/large.jpg" } } } } };
    } });
    assert.ok((await art.getLandscapeArtwork("55")).body.length > 0);
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
    assert.equal(info.width, 960);
    assert.equal(info.height, 540);
    const pixel = (x, y, channel) => data[(y * 960 + x) * info.channels + channel];
    assert.ok(pixel(480, 10, 0) > 240, "top of poster retained");
    assert.ok(pixel(480, 530, 2) > 240, "bottom of poster retained");
    assert.ok(pixel(10, 270, 0) < 30, "side margin retained");
  }
});

test("failed image requests can recover and are not cached as successes", async () => {
  let offline = true;
  const art = load(artworkFile, { "node-fetch": async (url) => {
    if (url === "https://images.example/cover.jpg") return asset();
    if (offline) throw new Error("offline");
    return { ok: true, json: async () => ({ data: { id: "99", attributes: { coverImage: { large: "https://images.example/cover.jpg" } } } }) };
  } });
  await assert.rejects(art.getLandscapeArtwork("99"), /offline/);
  offline = false;
  assert.ok((await art.getLandscapeArtwork("99")).body.length > 0);
});

test("wide Kitsu banners retain both edges within 16:9 instead of being cover cropped", async () => {
  const pixels = Buffer.alloc(120 * 40 * 3);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 120; x++) {
    pixels[(y * 120 + x) * 3 + (x < 60 ? 0 : 2)] = 255;
  }
  const input = await sharp(pixels, { raw: { width: 120, height: 40, channels: 3 } }).png().toBuffer();
  const art = load(artworkFile, { "node-fetch": async url => {
    if (url.includes("easycatalogs")) throw new Error("offline");
    if (url.includes("kitsu.io")) return { ok: true, json: async () => ({ data: { id: "55", attributes: { coverImage: { original: "https://images.example/banner.jpg" } } } }) };
    return { ok: true, buffer: async () => input };
  } });
  const { data, info } = await sharp((await art.getLandscapeArtwork("55")).body).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width / info.height, 16 / 9);
  const pixel = (x, y, c) => data[(y * info.width + x) * info.channels + c];
  assert.ok(pixel(5, 270, 0) > 240, "left edge retained");
  assert.ok(pixel(955, 270, 2) > 240, "right edge retained");
  assert.ok(pixel(480, 10, 0) < 30, "wide banner has margins rather than cropped sides");
});

test("unavailable provider image and corrupt Kitsu cover fall back to a valid poster JPEG", async () => {
  const requested = [];
  const art = load(artworkFile, { "node-fetch": async url => {
    requested.push(url);
    if (url.includes("easycatalogs")) return { ok: true, json: async () => ({ meta: { id: "kitsu:55", type: "series", background: "https://images.example/missing.jpg" } }) };
    if (url.includes("kitsu.io")) return { ok: true, json: async () => ({ data: { id: "55", attributes: { coverImage: { original: "https://images.example/corrupt.jpg" }, posterImage: { original: meta.poster } } } }) };
    if (url.endsWith("missing.jpg")) return { ok: false, status: 404 };
    if (url.endsWith("corrupt.jpg")) return { ok: true, buffer: async () => Buffer.from("not an image") };
    assert.equal(url, meta.poster);
    return asset();
  } });
  const result = await art.getLandscapeArtwork("55");
  assert.equal((await sharp(result.body).metadata()).format, "jpeg");
  assert.equal(requested.at(-1), meta.poster);
  assert.ok(requested.some(url => url.endsWith("missing.jpg")));
  assert.ok(requested.some(url => url.endsWith("corrupt.jpg")));
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
    assert.equal(landscape.metas[0].poster, "/artwork/landscape/series/55.jpg?v=3");
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
  assert.equal(json.metas[0].poster, `${base.replace("http:", "https:")}/artwork/landscape/series/55.jpg?v=3`);
  assert.equal(json.metas[0].background, json.metas[0].poster);
  // Reproduce the actual production proxy headers. Previously this generated
  // https://2e89550f1b1c-dubbedanimefeed/... (not a public DNS hostname).
  const beamup = await require("node-fetch")(`${base}/catalog/series/au-dubbed-latest-series.json`, {
    headers: { host: "2e89550f1b1c-dubbedanimefeed", "x-forwarded-proto": "https" },
  });
  const deployed = (await beamup.json()).metas[0];
  assert.equal(deployed.poster, "https://2e89550f1b1c-dubbedanimefeed.baby-beamup.club/artwork/landscape/series/55.jpg?v=3");
  assert.equal(deployed.background, deployed.poster);
  const image = await fetch(`${base}/artwork/landscape/series/55.jpg?v=3`);
  assert.match(image.headers.get("content-type"), /image\/jpeg/);
  assert.equal(image.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
  assert.equal((await fetch(`${base}/artwork/landscape/invalid.jpg`)).status, 404);
});

test("public artwork origin respects forwarded domains, Beamup internal hosts and local development", () => {
  const { publicOrigin } = load(artworkFile, {});
  const request = (headers, protocol = "http") => ({ protocol, get: name => headers[name] });
  assert.equal(publicOrigin(request({ host: "2e89550f1b1c-dubbedanimefeed" })), "https://2e89550f1b1c-dubbedanimefeed.baby-beamup.club");
  assert.equal(publicOrigin(request({ host: "internal:7000", "x-forwarded-host": "anime.example.com, proxy.internal", "x-forwarded-proto": "https, http" })), "https://anime.example.com");
  assert.equal(publicOrigin(request({ host: "localhost:7000" })), "http://localhost:7000");
  assert.equal(publicOrigin(request({ host: "anime.example.com" }, "https")), "https://anime.example.com");
});
