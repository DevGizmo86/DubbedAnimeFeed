const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const express = require('express');
const sharp = require('sharp');
function load(filename, mocks) {
  delete require.cache[filename];
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (parent?.filename === filename && request in mocks) return mocks[request];
    return original.call(this, request, parent, isMain);
  };
  try { return require(filename); } finally { Module._load = original; }
}
const file = require.resolve('../services/artwork');
const meta = { id: 'kitsu:49739', type: 'movie', name: 'Super Cube', poster: 'https://source.example/vertical.jpg', background: 'https://source.example/wrong.jpg' };
const response = attributes => ({ ok: true, json: async () => ({ data: { id: '49739', attributes }, included: [{type:'mappings', attributes:{externalSite:'thetvdb/series',externalId:'123'}}] }) });

test('TMDB receives the configured key and actual Kitsu ONA subtype while catalog/episode identity stays Kitsu', async () => {
  let calls = 0;
  const art = load(file, {
    'node-fetch': async url => { assert.equal(url, 'https://kitsu.io/api/edge/anime/49739?include=mappings'); return response({subtype:'ONA',titles:{en:'Super Cube'},startDate:'2025-03-21'}); },
    './tmdb-artwork': { getBackdrop: async (key, info) => {
      calls++; assert.equal(key,'test-key'); assert.equal(info.isMovie,false); assert.equal(info.tvdbId,'123'); assert.equal(info.kitsuId,'49739');
      return 'https://image.tmdb.org/t/p/w1280/backdrop.jpg';
    } },
  });
  const [first,second] = await Promise.all([art.landscapePreview(meta,'test-key'),art.landscapePreview(meta,'test-key')]);
  assert.equal(first.poster,'https://image.tmdb.org/t/p/w1280/backdrop.jpg');
  assert.equal(first.background,first.poster); assert.equal(first.landscapePoster,first.poster);
  assert.equal(first.id,meta.id); assert.equal(first.type,meta.type); assert.deepEqual(second,first);
  assert.equal(meta.poster,'https://source.example/vertical.jpg'); assert.equal(calls,1);
  assert.ok(!first.poster.includes('test-key'));
});

test('fallbacks are Kitsu covers or real episode stills, never EasyCatalogs or vertical posters', async () => {
  const urls=[];
  const art=load(file,{'node-fetch':async url=>{
    urls.push(url);
    if(url.endsWith('?include=mappings'))return response({subtype:'ONA',posterImage:{original:'https://source.example/vertical.jpg'}});
    assert.equal(url,'https://kitsu.io/api/edge/anime/49739/episodes?page%5Blimit%5D=5&sort=number');
    return {ok:true,json:async()=>({data:[{attributes:{thumbnail:{original:'https://media.kitsu.app/still.jpg'}}}]})};
  },'./tmdb-artwork':{getBackdrop:async()=>null}});
  assert.equal((await art.landscapePreview(meta)).poster,'https://media.kitsu.app/still.jpg');
  assert.equal(urls.length,2); assert.ok(urls.every(url=>url.startsWith('https://kitsu.io/')));
});

test('adding/changing TMDB keys bypasses keyless fallback caches; outages are not cached as valid images', async () => {
  let offline=true;
  const art=load(file,{'node-fetch':async()=>{if(offline)throw Error('offline'); return response({subtype:'ONA',coverImage:{original:'https://media.kitsu.app/cover.jpg'}})},'./tmdb-artwork':{getBackdrop:async key=>key==='test-key'?'https://image.tmdb.org/t/p/w1280/tmdb.jpg':null}});
  assert.equal((await art.landscapePreview(meta)).poster,undefined);
  offline=false;
  assert.equal(await art.getLandscapeUrl('49739'),'https://media.kitsu.app/cover.jpg');
  assert.equal(await art.getLandscapeUrl('49739','test-key'),'https://image.tmdb.org/t/p/w1280/tmdb.jpg');
  await assert.rejects(art.getLandscapeUrl('../secret'),/Invalid/);
});

test('no horizontal artwork does not reuse source portrait or add padding',async()=>{
  const art=load(file,{'node-fetch':async url=>url.includes('/episodes?')?{ok:true,json:async()=>({data:[]})}:response({subtype:'ONA',posterImage:{original:meta.poster}}),'./tmdb-artwork':{getBackdrop:async()=>null}});
  const result=await art.landscapePreview(meta); assert.equal(result.poster,undefined); assert.equal(result.background,undefined);
});

test('all seven catalogs pass the addon key to landscape resolution; portrait requests bypass it',async()=>{
  const calls=[];
  const catalog=async()=>[meta];
  const addon=load(require.resolve('../addon'),{'./services/animeunity':{getDubbedCatalog:catalog,searchDubbedCatalog:catalog,getTopDubbedCatalog:catalog,getTopAiringDubbedCatalog:catalog},'./services/artwork':{landscapePage:async(metas,key)=>{calls.push(key);return metas.map(m=>({...m,poster:'https://image.tmdb.org/t/p/w1280/real.jpg',posterShape:'landscape'}))}}});
  for(const c of addon.manifest.catalogs){
    const result=await addon.get('catalog',c.type,c.id,{search:'example'},{posterOrientation:'landscape',tmdbKey:'test-key'});
    assert.equal(result.metas[0].poster,'https://image.tmdb.org/t/p/w1280/real.jpg');
    const portrait=await addon.get('catalog',c.type,c.id,{search:'example'},{tmdbKey:'test-key'});
    assert.equal(portrait.metas[0].poster,meta.poster);
  }
  assert.deepEqual(calls,Array(7).fill('test-key'));
});

test('legacy image endpoint serves real horizontal JPEGs without letterbox padding and rejects vertical files',async()=>{
  const input=await sharp({create:{width:300,height:100,channels:3,background:'#ff0000'}}).png().toBuffer();
  const art=load(file,{'node-fetch':async url=>url.includes('?include=mappings')?response({coverImage:{original:'https://media.kitsu.app/cover.jpg'}}):{ok:true,buffer:async()=>input},'./tmdb-artwork':{getBackdrop:async()=>null}});
  const {body}=await art.getLandscapeArtwork('49739');
  const {data,info}=await sharp(body).raw().toBuffer({resolveWithObject:true});
  assert.equal(info.width,960);assert.equal(info.height,540);assert.ok(data[0]>240);assert.ok(data.at(-3)>240);
});

test('public URL handling supports production Beamup internal hosts and forwarded domains',()=>{
  const {publicOrigin,absoluteArtwork}=load(file,{});
  const request=(headers,protocol='http')=>({protocol,get:name=>headers[name]});
  const origin=publicOrigin(request({host:'2e89550f1b1c-dubbedanimefeed'}));
  assert.equal(origin,'https://2e89550f1b1c-dubbedanimefeed.baby-beamup.club');
  assert.equal(publicOrigin(request({host:'internal:7000','x-forwarded-host':'anime.example.com, proxy','x-forwarded-proto':'https, http'})),'https://anime.example.com');
  const url='https://image.tmdb.org/t/p/w1280/real.jpg';
  assert.equal(absoluteArtwork({metas:[{...meta,poster:url}]},origin).metas[0].poster,url);
});

test('HTTP configured catalogs return direct CDN URLs and legacy artwork route remains compatible',async t=>{
  const app=express(),listen=app.listen.bind(app); app.listen=()=>{};
  const jpeg=await sharp({create:{width:960,height:540,channels:3,background:'red'}}).jpeg().toBuffer();
  const art=load(file,{});
  const addon={manifest:require('../addon').manifest,get:async()=>({metas:[{...meta,poster:'https://image.tmdb.org/t/p/w1280/direct.jpg'}]})};
  load(require.resolve('../index'),{express:Object.assign(()=>app,{static:express.static}),'./addon':addon,'./services/artwork':{...art,getLandscapeArtwork:async()=>({body:jpeg})}});
  const server=listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const catalog=await fetch(`${base}/catalog/series/au-dubbed-latest-series.json`);
  assert.equal((await catalog.json()).metas[0].poster,'https://image.tmdb.org/t/p/w1280/direct.jpg');
  const image=await fetch(`${base}/artwork/landscape/movie/49739.jpg`);
  assert.match(image.headers.get('content-type'),/image\/jpeg/);assert.deepEqual(Buffer.from(await image.arrayBuffer()),jpeg);
});

test('empty catalog HTTP responses expire after one minute instead of proxy defaults',async t=>{
 const catalog=async()=>[];
 const addon=load(require.resolve('../addon'),{'./services/animeunity':{getDubbedCatalog:catalog,searchDubbedCatalog:catalog,getTopDubbedCatalog:catalog,getTopAiringDubbedCatalog:catalog}});
 const app=express();app.use(require('stremio-addon-sdk').getRouter(addon));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 for(const c of addon.manifest.catalogs){
  const r=await fetch(`http://127.0.0.1:${server.address().port}/catalog/${c.type}/${c.id}.json`);
  assert.match(r.headers.get('cache-control'),/^max-age=60,/);assert.deepEqual((await r.json()).metas,[]);
 }
});
