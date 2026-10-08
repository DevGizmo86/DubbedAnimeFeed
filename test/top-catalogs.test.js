const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadService(name, mocks) {
  const path = require.resolve(`../services/${name}`);
  delete require.cache[path];
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (parent?.filename === path && request in mocks) return mocks[request];
    return original.call(this, request, parent, isMain);
  };
  try { return require(path); } finally { Module._load = original; }
}
const response = (json) => ({ ok: true, json: async () => json });

test('Jikan failures and malformed responses do not poison the ranking cache', async () => {
  let calls = 0;
  const mal = loadService('mal', { 'node-fetch': async (url) => {
    if (url.startsWith('https://myanimelist.net/')) throw new Error('MyAnimeList unavailable');
    calls++;
    if (calls === 1) return { ok: false, status: 502 };
    if (calls === 2) return response({ error: 'upstream failure' });
    return response({ data: [{ mal_id: 1, title: 'Example', rank: 1 }] });
  }});
  await assert.rejects(mal.getTopAnime(1), /MyAnimeList unavailable/);
  await assert.rejects(mal.getTopAnime(1), /MyAnimeList unavailable/);
  assert.equal((await mal.getTopAnime(1)).length, 1);
  assert.equal((await mal.getTopAnime(1)).length, 1);
  assert.equal(calls, 3);
});

test('all three top catalogs recover after an archive failure and share archive requests', async () => {
  let archiveCalls = 0;
  let homeCalls = 0;
  const animeunity = loadService('animeunity', {
    'node-fetch': async (url) => {
      if (url.endsWith('/')) {
        homeCalls++;
        return { ok: true, headers: { raw: () => ({}) }, text: async () => '<meta name="csrf-token" content="test">' };
      }
      if (url.includes('get-animes')) {
        archiveCalls++;
        if (archiveCalls === 1) return { ok: false, status: 503 };
        if (archiveCalls === 2) return { ok: false, status: 419 };
        return response({ records: [
          { id: 1, mal_id: 1, type: 'TV', title_eng: 'Series' },
          { id: 2, mal_id: 2, type: 'Movie', title_eng: 'Film' },
        ] });
      }
      const id = new URL(url).searchParams.get('filter[externalId]');
      return response({ included: [{ id }] });
    },
    './mal': { getTopAnime: async () => [{ mal_id: 1 }, { mal_id: 2 }] },
    './tmdb': {},
  });
  await assert.rejects(animeunity.getTopDubbedCatalog('series', 0), /503/);
  const [series, movies, airing] = await Promise.all([
    animeunity.getTopDubbedCatalog('series', 0),
    animeunity.getTopDubbedCatalog('movie', 0),
    animeunity.getTopAiringDubbedCatalog(0),
  ]);
  assert.equal(series.length, 1);
  assert.equal(movies.length, 1);
  assert.equal(airing.length, 2);
  assert.equal(archiveCalls, 3);
  assert.equal(homeCalls, 2);
});


test('Jikan failure falls back to the same MAL airing ranking and shares concurrent loads', async () => {
  let calls = 0;
  const mal = loadService('mal', { 'node-fetch': async (url, options) => {
    calls++;
    assert(options.timeout > 0);
    if (url.startsWith('https://api.jikan.moe/')) return { ok: false, status: 502 };
    assert.equal(url, 'https://myanimelist.net/topanime.php?type=airing&limit=0');
    return { ok: true, text: async () => `<tr class="ranking-list"><td><span class="lightLink top-anime-rank-text rank1">1</span></td><td><h3><a href="https://myanimelist.net/anime/123/Example">Example</a></h3></td></tr>` };
  }});
  const [first, second] = await Promise.all([mal.getTopAnime(20, 'airing'), mal.getTopAnime(20, 'airing')]);
  assert.deepEqual(first, [{ mal_id: 123, rank: 1, title: 'Example' }]);
  assert.deepEqual(second, first);
  assert.equal(calls, 2);
  assert.deepEqual(await mal.getTopAnime(20, 'airing'), first);
  assert.equal(calls, 2);
});

test('MAL error pages are rejected and are not cached as empty rankings', async () => {
  const mal = loadService('mal', { 'node-fetch': async (url) => {
    if (url.startsWith('https://api.jikan.moe/')) return { ok: false, status: 502 };
    return { ok: true, text: async () => '<html>Unavailable</html>' };
  }});
  await assert.rejects(mal.getTopAnime(1), /unavailable or unrecognized/);
  assert.deepEqual(mal.parseMalRanking('<html>Unavailable</html>'), []);
});

function rankingRow(id, rank) {
  return `<tr class="ranking-list"><td><span class="top-anime-rank-text">${rank}</span></td><td><h3><a href="https://myanimelist.net/anime/${id}/Example">Example</a></h3></td></tr>`;
}

test('MAL accepts unranked airing entries and stops at a full final page without next', async () => {
  const offsets = [];
  const mal = loadService('mal', { 'node-fetch': async (url) => {
    if (url.startsWith('https://api.jikan.moe/')) return { ok: false, status: 502 };
    const offset = Number(new URL(url).searchParams.get('limit'));
    offsets.push(offset);
    const rows = Array.from({ length: 50 }, (_, i) => rankingRow(offset + i + 1, offset ? '-' : i + 1)).join('');
    return { ok: true, text: async () => rows + (offset === 0 ? '<link rel="next" href="?type=airing&amp;limit=50">' : '') };
  }});
  const rows = await mal.getTopAnime(20, 'airing');
  assert.equal(rows.length, 100);
  assert.equal(rows[50].rank, null);
  assert.equal(rows[99].mal_id, 100);
  assert.deepEqual(offsets, [0, 50]);
});

test('MAL terminal 404 preserves valid pages; unrelated errors still reject', async () => {
  let unrelated = false;
  const mal = loadService('mal', { 'node-fetch': async (url) => {
    if (url.startsWith('https://api.jikan.moe/')) return { ok: false, status: 502 };
    if (new URL(url).searchParams.get('limit') === '0') return { ok: true, text: async () => Array.from({ length: 50 }, (_, i) => rankingRow(i + 1, i + 1)).join('') + '<link rel="next" href="?limit=50">' };
    return { ok: false, status: 404, text: async () => unrelated ? '<html>Gateway route not found</html>' : '<title>404 Not Found - MyAnimeList.net</title>' };
  }});
  assert.equal((await mal.getTopAnime(20, 'airing')).length, 50);
  unrelated = true;
  await assert.rejects(mal.getTopAnime(20), /MyAnimeList top error: 404/);
});
