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
  const mal = loadService('mal', { 'node-fetch': async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 502 };
    if (calls === 2) return response({ error: 'upstream failure' });
    return response({ data: [{ mal_id: 1, title: 'Example', rank: 1 }] });
  }});
  await assert.rejects(mal.getTopAnime(1), /502/);
  await assert.rejects(mal.getTopAnime(1), /Invalid/);
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
