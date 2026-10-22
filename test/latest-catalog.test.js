const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadService(name, mocks) {
  const filename = require.resolve(`../services/${name}`);
  delete require.cache[filename];
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (parent?.filename === filename && request in mocks) return mocks[request];
    return original.call(this, request, parent, isMain);
  };
  try { return require(filename); } finally { Module._load = original; }
}

const anime = (id, type = "TV") => ({ id, mal_id: id, title: `Anime ${id}`, type, dub: 1 });
const feed = (items) => ({
  ok: true,
  text: async () => `<layout-items items-json="${JSON.stringify({ data: items }).replace(/"/g, "&quot;")}"></layout-items>`,
});
const episodes = (records) => records.map((anime, i) => ({ anime, number: i + 1, created_at: "2026-10-01 12:00:00" }));

function service({ au, aw, mapping = (id) => id }) {
  return loadService("animeunity", {
    "node-fetch": async (url) => {
      if (url.startsWith("https://www.animeunity.so")) {
        if (url.includes("?page=")) return feed([]);
        return au();
      }
      const id = new URL(url).searchParams.get("filter[externalId]");
      const mapped = await mapping(id);
      return { ok: true, json: async () => ({ included: mapped ? [{ id: String(mapped) }] : [] }) };
    },
    "./animeworld": { getDubbedRecords: aw },
    "./mal": {}, "./tmdb": {},
  });
}

test("latest catalogs merge both rankings and deduplicate by Kitsu before pagination", async () => {
  let auCalls = 0;
  let awCalls = 0;
  const latest = service({
    au: () => { auCalls++; return feed(episodes([anime(1), anime(2), anime(4, "Movie")])); },
    aw: async () => { awCalls++; return [anime(10), anime(3), anime(40, "Movie")]; },
    mapping: (id) => ({ 10: 1, 40: 4 }[id] || id),
  });
  const [series, movies] = await Promise.all([
    latest.getDubbedCatalog("series", 0), latest.getDubbedCatalog("movie", 0),
  ]);
  assert.deepEqual(series.map((m) => m.id), ["kitsu:1", "kitsu:2", "kitsu:3"]);
  assert.deepEqual(movies.map((m) => m.id), ["kitsu:4"]);
  assert.equal(auCalls, 1);
  assert.equal(awCalls, 1);
});

test("interleaving preserves relative source positions and never sorts by episode count", async () => {
  const latest = service({
    au: () => feed(episodes([anime(1), anime(3)])),
    aw: async () => [{ ...anime(2), _latestEpisode: "942" }, anime(4)],
  });
  assert.deepEqual((await latest.getDubbedCatalog("series", 0)).map((m) => m.id), ["kitsu:1", "kitsu:2", "kitsu:3", "kitsu:4"]);
});

test("one unavailable source does not prevent the other from returning results", async () => {
  for (const failed of ["au", "aw"]) {
    const latest = service({
      au: () => failed === "au" ? { ok: false, status: 503 } : feed(episodes([anime(1)])),
      aw: async () => { if (failed === "aw") throw new Error("offline"); return [anime(2)]; },
    });
    const metas = await latest.getDubbedCatalog("series", 0);
    assert.deepEqual(metas.map((m) => m.id), [failed === "au" ? "kitsu:2" : "kitsu:1"]);
  }
});

test("invalid AnimeUnity HTML is a failure, and a cold total outage recovers after cooldown", async (t) => {
  let now = 1000000;
  t.mock.method(Date, "now", () => now);
  let offline = true;
  const latest = service({
    au: () => ({ ok: true, text: async () => "<html>maintenance</html>" }),
    aw: async () => { if (offline) throw new Error("offline"); return [anime(2)]; },
  });
  await assert.rejects(latest.getDubbedCatalog("series", 0), /All latest dubbed sources unavailable/);
  offline = false;
  now += 60001;
  assert.equal((await latest.getDubbedCatalog("series", 0))[0].id, "kitsu:2");
});

test("last valid results survive a total outage without extending their age", async (t) => {
  let now = 1000000;
  t.mock.method(Date, "now", () => now);
  let offline = false;
  const latest = service({
    au: () => offline ? { ok: false, status: 503 } : feed(episodes([anime(1)])),
    aw: async () => { if (offline) throw new Error("offline"); return [anime(2)]; },
  });
  const original = await latest.getDubbedCatalog("series", 0);
  offline = true;
  now += 11 * 60 * 1000;
  assert.deepEqual(await latest.getDubbedCatalog("series", 0), original);
  now += 24 * 60 * 60 * 1000;
  await assert.rejects(latest.getDubbedCatalog("series", 0), /All latest dubbed sources unavailable/);
});

test("a failed source's last records follow fresh results and recovery restores interleaving", async (t) => {
  let now = 1000000;
  t.mock.method(Date, "now", () => now);
  let offline = false;
  const latest = service({
    au: () => offline ? { ok: false, status: 503 } : feed(episodes([anime(1)])),
    aw: async () => [anime(2)],
  });
  await latest.getDubbedCatalog("series", 0);
  offline = true;
  now += 11 * 60 * 1000;
  assert.deepEqual((await latest.getDubbedCatalog("series", 0)).map((m) => m.id), ["kitsu:2", "kitsu:1"]);
  offline = false;
  now += 11 * 60 * 1000;
  assert.deepEqual((await latest.getDubbedCatalog("series", 0)).map((m) => m.id), ["kitsu:1", "kitsu:2"]);
});

test("Kitsu mapping outages do not cache an empty latest catalog", async () => {
  let offline = true;
  const latest = service({
    au: () => feed(episodes([anime(1)])), aw: async () => [anime(1)],
    mapping: (id) => { if (offline) throw new Error("Kitsu offline"); return id; },
  });
  await assert.rejects(latest.getDubbedCatalog("series", 0), /Kitsu mappings unavailable/);
  offline = false;
  assert.equal((await latest.getDubbedCatalog("series", 0)).length, 1);
});

test("a healthy source cannot extend an expired failed source snapshot", async (t) => {
  let now = 1000000;
  t.mock.method(Date, "now", () => now);
  let auOffline = false;
  let awOffline = false;
  const latest = service({
    au: () => auOffline ? { ok: false, status: 503 } : feed(episodes([anime(1)])),
    aw: async () => { if (awOffline) throw new Error("offline"); return [anime(2)]; },
  });
  await latest.getDubbedCatalog("series", 0);
  auOffline = true;
  now += 11 * 60 * 1000;
  await latest.getDubbedCatalog("series", 0);
  awOffline = true;
  now += 24 * 60 * 60 * 1000 - 10 * 60 * 1000;
  assert.deepEqual((await latest.getDubbedCatalog("series", 0)).map((m) => m.id), ["kitsu:2"]);
});

test("pagination happens after deduplication, without dropping unique entries", async () => {
  const records = Array.from({ length: 65 }, (_, i) => anime(i + 1));
  const latest = service({ au: () => feed(episodes(records)), aw: async () => records });
  const first = await latest.getDubbedCatalog("series", 0);
  const second = await latest.getDubbedCatalog("series", 50);
  assert.equal(first.length, 50);
  assert.equal(second.length, 15);
  assert.equal(new Set([...first, ...second].map((m) => m.id)).size, 65);
});

const card = (slug, episode, dubbed = true) => `<div class="item"><a class="poster"><img src="https://img.example/${slug}.jpg"><div class="status">${dubbed ? '<div class="dub">DUB</div>' : ''}<div class="ep">Ep ${episode}</div></div></a><a class="name" href="/play/${slug}/episode-${episode}">Example &amp; Friends (ITA)</a></div>`;
const home = (cards) => `<div class="content" data-name="all">${card("sub", 1, false)}</div><div class="content hidden" data-name="dub"><div class="film-list">${cards}</div></div>`;
const detail = (type = "Anime", mal = 123) => `<a href="https://myanimelist.net/anime/${mal}">MAL</a><a href="https://anilist.co/anime/456">AniList</a><meta name="description" content="Trama di Example (ITA) ITA: Italian plot"><div class="widget info"><h2 class="title">Example (ITA)</h2><dl class="meta"><dt>Categoria:</dt><dd>${type}</dd><dt>Data di Uscita:</dt><dd>11 Ottobre 2024</dd></dl></div>`;

test("AnimeWorld parses only DUB cards and keeps each title's most recent occurrence", () => {
  const aw = require("../services/animeworld");
  const records = aw.parseFeed(home(card("one.abc", 12) + card("one.abc", 11) + card("two.def", 1) + card("sub", 2, false)));
  assert.equal(records.length, 2);
  assert.equal(records[0]._latestEpisode, "12");
  assert.equal(records[0].title, "Example & Friends (ITA)");
  assert.equal(records[0]._url, "https://www.animeworld.ac/play/one.abc");
  assert.equal(records[0]._episodeAt, undefined);
  assert.throws(() => aw.parseFeed("<html>unavailable</html>"), /missing/);
  assert.throws(() => aw.parseFeed(home("")), /empty/);
});

test("AnimeWorld details preserve external IDs, category and plot without inventing an episode date", () => {
  const aw = require("../services/animeworld");
  const series = aw.parseDetail(detail());
  assert.equal(series.mal_id, "123");
  assert.equal(series.anilist_id, "456");
  assert.equal(series.type, "TV");
  assert.equal(series.plot, "Italian plot");
  assert.equal(series.date, "2024");
  assert.equal(series._episodeAt, undefined);
  assert.equal(aw.parseDetail(detail("Movie")).type, "Movie");
  assert.equal(aw.parseDetail(detail("ONA")).type, "ONA");
  assert.throws(() => aw.parseDetail("<html>unavailable</html>"), /missing or unrecognized/);
});

test("AnimeWorld skips failed details, preserves feed order and reuses successful detail metadata", async () => {
  let detailCalls = 0;
  const aw = loadService("animeworld", { "node-fetch": async (url) => {
    if (url.endsWith("/")) return { ok: true, text: async () => home(card("one.abc", 3) + card("two.def", 2) + card("three.ghi", 1)) };
    detailCalls++;
    if (url.endsWith("two.def")) return { ok: false, status: 503 };
    // All requests must be title pages without an episode/video path.
    assert.match(url, /^https:\/\/www\.animeworld\.ac\/play\/[^/]+$/);
    return { ok: true, text: async () => detail("Anime", url.endsWith("one.abc") ? 1 : 3) };
  }});
  assert.deepEqual((await aw.getDubbedRecords()).map((r) => r.mal_id), ["1", "3"]);
  assert.equal(detailCalls, 3);
  assert.deepEqual((await aw.getDubbedRecords()).map((r) => r.mal_id), ["1", "3"]);
  assert.equal(detailCalls, 4);
});
