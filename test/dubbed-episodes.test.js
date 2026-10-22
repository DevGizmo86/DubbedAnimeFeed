const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function load(name, mocks) {
  const filename = require.resolve(`../services/${name}`);
  delete require.cache[filename];
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (parent?.filename === filename && request in mocks) return mocks[request];
    return original.call(this, request, parent, isMain);
  };
  try { return require(filename); } finally { Module._load = original; }
}

const meta = (numbers = [1, 2, 3, 4]) => ({
  id: "kitsu:55", type: "series", name: "Example", cast: ["Actor"],
  videos: numbers.map((number) => ({
    id: `kitsu:55:${number}`, title: `Titolo ${number}`, season: 1, episode: number,
    overview: "Trama italiana", thumbnail: "https://example.test/episode.jpg",
  })),
});
const source = (record = {}) => ({ source: "AnimeUnity", at: Date.now(), record: { id: 10, mal_id: 123, ...record } });

function labels({ sources = () => [source()], au = async () => [], aw = async () => [], fetch } = {}) {
  return load("dubbed-episodes", {
    "./animeunity": { getDubbedSources: sources, getDubbedEpisodes: au },
    "./animeworld": { getDubbedEpisodes: aw },
    "node-fetch": fetch || (async () => { throw new Error("unexpected network request"); }),
  });
}

test("ITA labels use the union of exact episode lists, preserve holes and never mutate base metadata", async () => {
  const service = labels({ au: async () => [1, 3], aw: async () => [3, 4] });
  const base = meta();
  const before = structuredClone(base);
  const result = await service.annotateDubbedEpisodes(base, "55", { titles: ["Example"] });
  assert.deepEqual(result.videos.map((v) => v.title), ["[ITA] Titolo 1", "Titolo 2", "[ITA] Titolo 3", "[ITA] Titolo 4"]);
  assert.deepEqual(base, before);
  assert.deepEqual(result.videos.map(({ title, ...v }) => v), before.videos.map(({ title, ...v }) => v));
  assert.deepEqual(result.cast, ["Actor"]);
});

test("a latest episode/count never implies that all previous episodes are dubbed", async () => {
  const service = labels({
    sources: () => [source({ _latestEpisode: "942", episodes_count: 1000, _observedAt: Date.now(), _confirmedDubbedEpisodes: [942] })],
    au: async () => { throw new Error("offline"); }, aw: async () => { throw new Error("offline"); },
  });
  const result = await service.annotateDubbedEpisodes(meta([1, 941, 942, 943]), "55", {});
  assert.deepEqual(result.videos.map((v) => v.title), ["Titolo 1", "Titolo 941", "[ITA] Titolo 942", "Titolo 943"]);
});

test("unverified identities, specials, fractions and different episode IDs stay untouched", async () => {
  const service = labels({ aw: async () => [1, 2, "3.5", "4-5", 0] });
  const base = meta();
  base.videos[0].id = "tt999:1:1";
  base.videos[1].season = 0;
  assert.deepEqual(await service.annotateDubbedEpisodes(base, "55", {}), base);
});

test("source failures stay unconfirmed, retry quickly, and recover without rebuilding Kitsu metadata", async (t) => {
  let now = 1000000;
  t.mock.method(Date, "now", () => now);
  let offline = true;
  const service = labels({ aw: async () => { if (offline) throw new Error("offline"); return [2]; } });
  const base = meta();
  assert.deepEqual(await service.annotateDubbedEpisodes(base, "55", {}), base);
  offline = false;
  now += 60001;
  const result = await service.annotateDubbedEpisodes(base, "55", {});
  assert.equal(result.videos[1].title, "[ITA] Titolo 2");
  assert.equal(base.videos[1].title, "Titolo 2");
});

test("expired positive evidence disappears when sources cannot confirm it again", async (t) => {
  let now = 1000000;
  t.mock.method(Date, "now", () => now);
  const observedAt = now;
  let offline = false;
  const service = labels({
    sources: () => [source({ _observedAt: observedAt, _confirmedDubbedEpisodes: [1] })],
    aw: async () => { if (offline) throw new Error("offline"); return [1]; },
  });
  assert.equal((await service.annotateDubbedEpisodes(meta(), "55", {})).videos[0].title, "[ITA] Titolo 1");
  offline = true;
  now += 10 * 60 * 1000 + 1;
  assert.equal((await service.annotateDubbedEpisodes(meta(), "55", {})).videos[0].title, "Titolo 1");
});

test("concurrent metadata requests share availability checks and prefixes are not duplicated", async () => {
  let calls = 0;
  const service = labels({ aw: async () => { calls++; return [1]; } });
  const base = meta();
  base.videos[0].title = "[ITA] Titolo 1";
  const results = await Promise.all(Array.from({ length: 3 }, () => service.annotateDubbedEpisodes(base, "55", {})));
  assert.equal(calls, 1);
  assert(results.every((m) => m.videos[0].title === "[ITA] Titolo 1"));
});

test("reopening a title after restart resolves exact Kitsu external IDs before an AnimeWorld search", async () => {
  let identity;
  const service = labels({
    sources: () => [],
    fetch: async (url) => {
      assert.equal(url, "https://kitsu.io/api/edge/anime/55/mappings");
      return { ok: true, json: async () => ({ data: [
        { attributes: { externalSite: "myanimelist/anime", externalId: "123" } },
        { attributes: { externalSite: "anilist/anime", externalId: "456" } },
      ] }) };
    },
    aw: async (ids) => { identity = ids; return [3]; },
  });
  const result = await service.annotateDubbedEpisodes(meta(), "55", { titles: ["Example"] });
  assert.deepEqual(identity, { mal_id: "123", anilist_id: "456" });
  assert.equal(result.videos[2].title, "[ITA] Titolo 3");
});

const card = (slug, dub = true) => `<div class="item">${dub ? '<div class="dub">DUB</div>' : ''}<a class="name" href="/play/${slug}">Example (ITA)</a></div>`;
const detail = ({ mal = 123, ani = 456, audio = "Italiano", numbers = [1, 3] } = {}) => `
  <a href="https://myanimelist.net/anime/${mal}">MAL</a><a href="https://anilist.co/anime/${ani}">AniList</a>
  <div class="widget info"><h2 class="title">Example (ITA)</h2><dl class="meta">
  <dt>Categoria:</dt><dd>Anime</dd><dt>Audio:</dt><dd>${audio}</dd></dl></div>
  <ul class="episodes">${numbers.map((n) => `<li class="episode"><a href="/play/example.abc/ep-${n}" data-episode-num="${n}">${n}</a></li>`).join('')}</ul>`;

test("AnimeWorld reads actual episode links and requires Italian audio instead of a title suffix", () => {
  const aw = require("../services/animeworld");
  assert.deepEqual(aw.parseDetail(detail({ numbers: [1, 3, 3, "3.5", "4-5", 0] }))._dubbedEpisodes, [1, 3]);
  assert.deepEqual(aw.parseDetail(detail({ audio: "Giapponese" }))._dubbedEpisodes, []);
});

test("AnimeWorld search validates both external IDs and rejects contradictory same-title results", async () => {
  const aw = load("animeworld", { "node-fetch": async (url) => {
    if (url.includes("/search?")) return { ok: true, text: async () => `<div class="film-list">${card("wrong.abc")}${card("right.def")}${card("sub.ghi", false)}</div>` };
    assert(!url.includes("sub.ghi"));
    return { ok: true, text: async () => detail({ mal: url.endsWith("wrong.abc") ? 999 : 123 }) };
  }});
  assert.deepEqual(await aw.getDubbedEpisodes({ mal_id: 123, anilist_id: 456 }, ["Example"]), [1, 3]);
});

test("AnimeWorld episode evidence refreshes independently from the long-lived title metadata cache", async (t) => {
  let now = 1000000;
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  const aw = load("animeworld", { "node-fetch": async () => {
    calls++;
    return { ok: true, text: async () => detail({ numbers: calls === 1 ? [1] : [1, 3] }) };
  }});
  const ref = { id: "aw:example.abc", mal_id: 123, anilist_id: 456 };
  assert.deepEqual(await aw.getDubbedEpisodes(ref), [1]);
  assert.deepEqual(await aw.getDubbedEpisodes(ref), [1]);
  assert.equal(calls, 1);
  now += 10 * 60 * 1000 + 1;
  assert.deepEqual(await aw.getDubbedEpisodes(ref), [1, 3]);
  assert.equal(calls, 2);
});

test("AnimeUnity paginates actual records, rejects mismatches and preserves confirmed pages on later failure", async () => {
  const ranges = [];
  const au = load("animeunity", { "node-fetch": async (url) => {
    const u = new URL(url);
    assert.equal(u.pathname, "/info_api/10-example-ita/0");
    const start = Number(u.searchParams.get("start_range"));
    ranges.push(start);
    if (start === 241) return { ok: false, status: 503 };
    const data = start === 1 ? [
      { id: 1, number: "1", anime_id: 10 }, { id: 3, number: "3", anime_id: 10 },
      { id: 4, number: "4", anime_id: 999 }, { id: 5, number: "5", is_uploaded: false },
      { id: 6, number: "6", available: 0 }, { id: 7, number: "1.5" },
    ] : [{ id: 121, number: "121", anime_id: 10 }];
    return { ok: true, json: async () => ({ episodes: data }) };
  }});
  assert.deepEqual(await au.getDubbedEpisodes({ id: 10, slug: "example-ita" }, 250), [1, 3, 121]);
  assert.deepEqual(ranges, [1, 121, 241]);
});

test("AnimeUnity catalog mapping keeps source evidence for subsequent episode requests", async () => {
  const au = load("animeunity", {
    "node-fetch": async (url) => {
      if (url.includes("animeunity.so")) return { ok: false, status: 503 };
      return { ok: true, json: async () => ({ included: [{ id: "55" }] }) };
    },
    "./animeworld": { getDubbedRecords: async () => [{ id: "aw:example.abc", mal_id: 123, type: "TV", title: "Example", _confirmedDubbedEpisodes: [3], _observedAt: Date.now() }] },
  });
  await au.getDubbedCatalog("series", 0);
  const sources = au.getDubbedSources("55");
  assert.equal(sources[0].source, "AnimeWorld");
  assert.deepEqual(sources[0].record._confirmedDubbedEpisodes, [3]);
});
