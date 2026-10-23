const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const cheerio = require("cheerio");
const express = require("express");
const { getRouter } = require("stremio-addon-sdk");

function loadWithMocks(filename, mocks) {
  delete require.cache[filename];
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === filename && request in mocks) return mocks[request];
    return original.call(this, request, parent, isMain);
  };
  try { return require(filename); } finally { Module._load = original; }
}

const calls = [];
const addon = loadWithMocks(require.resolve("../addon"), {
  "./services/kitsu": { getKitsuMeta: async (id, type, key, options) => {
    calls.push({ id, type, options });
    return { id: `kitsu:${id}`, type, name: "Example", videos: options.onlyDubbedEpisodes ? [{ id: `kitsu:${id}:3`, episode: 3 }] : [{ id: `kitsu:${id}:1`, episode: 1 }, { id: `kitsu:${id}:3`, episode: 3 }] };
  } },
});

test("configured HTTP metadata accepts checkbox form values while old and disabled configurations retain full lists", async (t) => {
  const app = express();
  app.use(getRouter(addon));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [config, filtered] of [[null, false], [{posterOrientation:"landscape"}, false], [{onlyDubbedEpisodes:"on"}, true], [{onlyDubbedEpisodes:true}, true], [{onlyDubbedEpisodes:"true"}, true], [{onlyDubbedEpisodes:false}, false], [{onlyDubbedEpisodes:"false"}, false], [{onlyDubbedEpisodes:"off"}, false]]) {
    const prefix = config ? `/${encodeURIComponent(JSON.stringify(config))}` : "";
    const response = await fetch(`${base}${prefix}/meta/series/kitsu:55.json`);
    assert.equal(response.status, 200);
    const { meta } = await response.json();
    assert.deepEqual(meta.videos.map((v) => v.episode), filtered ? [3] : [1, 3]);
    assert.deepEqual(calls.at(-1), { id: "55", type: "series", options: { onlyDubbedEpisodes: filtered } });
  }
});

test("configuration renders an unchecked accessible option with the source explanation directly beneath it", () => {
  const routes = new Map();
  const app = { use() {}, get(route, handler) { routes.set(route, handler); }, listen() {} };
  const sdk = require("stremio-addon-sdk");
  loadWithMocks(require.resolve("../index"), {
    express: Object.assign(() => app, { static: () => () => {} }),
    "./addon": addon,
    "stremio-addon-sdk": { ...sdk, getRouter: () => () => {} },
  });
  let html;
  routes.get("/configure")({}, { setHeader() {}, end(value) { html = value; } });
  const $ = cheerio.load(html);
  const option = $('#onlyDubbedEpisodes');
  assert.equal(option.length, 1);
  assert.equal(option.attr("type"), "checkbox");
  assert.equal(option.attr("checked"), undefined);
  const help = $(`#${option.attr("aria-describedby")}`);
  assert.equal(option.closest("label").next()[0], help[0]);
  assert.match(help.text(), /AnimeWorld o AnimeUnity/);
  assert.match(help.text(), /una delle due fonti/);
  assert.match(help.text(), /24 ore/);
  assert.match(help.text(), /tutti gli episodi/);
  assert.equal($("#copyManifestBtn").length, 1);
});
