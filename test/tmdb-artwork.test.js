const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module');
function service(fetch){const file=require.resolve('../services/tmdb-artwork');delete require.cache[file];const original=Module._load;Module._load=function(name,parent,...args){if(parent?.filename===file&&name==='node-fetch')return fetch;return original.call(this,name,parent,...args)};try{return require(file)}finally{Module._load=original}}
const response=value=>({ok:true,json:async()=>value});
const picture=(path,language=null,ratio=1.778)=>({file_path:path,iso_639_1:language,aspect_ratio:ratio,width:1920,height:1080});

test('exact external IDs take precedence and the Italian real backdrop is returned without API key',async()=>{
 const calls=[];const art=service(async raw=>{const u=new URL(raw);calls.push(u.pathname);assert.equal(u.searchParams.get('api_key'),'test-key');if(u.pathname==='/3/find/123')return response({tv_results:[{id:99}]});assert.equal(u.pathname,'/3/tv/99/images');return response({backdrops:[picture('/en.jpg','en'),picture('/portrait.jpg','it',0.7),picture('/it.jpg','it')]})});
 const info={kitsuId:'1',isMovie:false,tvdbId:'123',titles:['Example']};
 assert.equal(await art.getBackdrop('test-key',info),'https://image.tmdb.org/t/p/w1280/it.jpg');
 await art.getBackdrop('test-key',info);assert.equal(calls.length,2);
});

test('title fallback searches TV for ONA and rejects unrelated first results',async()=>{
 const art=service(async raw=>{const u=new URL(raw);if(u.pathname==='/3/search/tv'){assert.equal(u.searchParams.get('query'),'Super Cube');return response({results:[{id:1,name:'Unrelated'},{id:2,name:'Super Cube'}]})}assert.equal(u.pathname,'/3/tv/2/images');return response({backdrops:[picture('/cube.jpg')]})});
 assert.equal(await art.getBackdrop('test-key',{kitsuId:'49739',isMovie:false,titles:['Super Cube'],year:'2025'}),'https://image.tmdb.org/t/p/w1280/cube.jpg');
});

test('no backdrop uses a real episode still and never a portrait',async()=>{
 const art=service(async raw=>{const u=new URL(raw);if(u.pathname.endsWith('/episode/1/images'))return response({stills:[picture('/scene.jpg')]});return response({backdrops:[],posters:[picture('/poster.jpg',null,0.7)]})});
 assert.equal(await art.getBackdrop('test-key',{kitsuId:'5',isMovie:false,tmdbId:9}),'https://image.tmdb.org/t/p/w1280/scene.jpg');
});

test('missing key makes no requests and an invalid key does not poison another installation',async()=>{
 let calls=0;const art=service(async raw=>{calls++;if(new URL(raw).searchParams.get('api_key')==='bad-key')return{ok:false,status:401};return response({backdrops:[picture('/ok.jpg')]})});
 const info={kitsuId:'5',isMovie:true,tmdbId:9};assert.equal(await art.getBackdrop(null,info),null);assert.equal(calls,0);
 assert.equal(await art.getBackdrop('bad-key',info),null);assert.equal(await art.getBackdrop('valid-test-key',info),'https://image.tmdb.org/t/p/w1280/ok.jpg');
});
