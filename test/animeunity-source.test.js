const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadSource(fetch) {
  const filename = require.resolve("../services/animeunity-source");
  delete require.cache[filename];
  const load = Module._load;
  Module._load = function (name, parent, main) {
    if (name === "node-fetch" && parent?.filename === filename) return fetch;
    return load.call(this, name, parent, main);
  };
  try { return require(filename); }
  finally { Module._load = load; }
}

const response = data => ({ ok: true, json: async () => data });
const anime = { id: 70, slug: "example", type: "tv", title: "Example" };

test("AnimeUnity archive requests Italian metadata and retains verified records after a page error", async () => {
  const requested = [];
  const source = loadSource(async url => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/api/archive");
    assert.equal(parsed.searchParams.get("language"), "ita");
    assert.equal(parsed.searchParams.get("query"), "example");
    const page = Number(parsed.searchParams.get("page"));
    requested.push(page);
    if (page === 2) return { ok: false, status: 502 };
    return response({ last_page: 2, data: [
      { ...anime, mal_id: 42, variants: [{ language: "ita", episodes_count: 1 }] },
      { ...anime, id: 71, variants: [{ language: "ita", episodes_count: 0 }, { language: "jpn", episodes_count: 12 }] },
    ] });
  });
  const result = await source.getArchive("example", 6);
  assert.deepEqual(requested, [1, 2]);
  assert.deepEqual(result.records.map(({ id, type, mal_id }) => ({ id, type, mal_id })), [{ id: 70, type: "TV", mal_id: 42 }]);
  assert.equal(result.partial, true);
});

test("AnimeUnity recent releases resolve missing exact external IDs and keep real Italian episode numbers", async () => {
  const episode = (number, language = "ita") => ({ language, episode: { number, anime } });
  const source = loadSource(async url => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/home/latest-episodes") {
      assert.equal(parsed.searchParams.get("language"), "dub");
      return response({ last_page: 1, data: [episode("3"), episode("2", "jpn"), episode("1")] });
    }
    assert.equal(parsed.pathname, "/anime/70-example");
    const detail = JSON.stringify({ props: { anime: { ...anime, mal_id: 42 } } }).replace(/"/g, "&quot;");
    return { ok: true, text: async () => `<div data-page="${detail}"></div>` };
  });
  const [result] = await source.getRecent();
  assert.equal(result.mal_id, 42);
  assert.deepEqual(result._confirmedDubbedEpisodes, [3, 1]);
});
