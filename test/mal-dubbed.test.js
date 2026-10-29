const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module');
function service(fetch){const p=require.resolve('../services/mal-dubbed');delete require.cache[p];const original=Module._load;Module._load=function(n,parent,...args){if(n==='node-fetch'&&parent?.filename===p)return fetch;return original.call(this,n,parent,...args)};try{return require(p)}finally{Module._load=original}}
const page=(id,language='Italian')=>`<meta property="og:url" content="https://myanimelist.net/anime/${id}/Example/characters"><meta property="og:image" content="https://cdn.myanimelist.net/image.jpg"><div><span class="dark_text">Type:</span> TV</div><td><a href="https://myanimelist.net/people/123/Actor">Actor</a><div class="js-anime-character-language">${language}</div></td>`;
test('MAL requires an Italian cast credit on the exact anime page, never a language selector',()=>{
 const mal=service(()=>{throw Error('network')});const entry={mal_id:21,title:'One Piece'};
 assert.equal(mal.parseItalianCast(page(21),entry).mal_id,21);
 assert.equal(mal.parseItalianCast(page(21,'Japanese')+'<li id="lang_8">Italian</li>',entry),null);
 assert.equal(mal.parseItalianCast(page(21).replace('/people/123/Actor','/profile/Actor'),entry),null);
 assert.throws(()=>mal.parseItalianCast(page(22),entry),/mismatched/);
 assert.throws(()=>mal.parseItalianCast('<h1>Unavailable</h1>',entry),/unavailable/);
});
test('MAL lookup retains verified positives and retries provider failures',async()=>{
 let fail=true,calls=0;const mal=service(async()=>{calls++;if(fail)throw Error('offline');return{ok:true,text:async()=>page(21)}});
 const entries=[{mal_id:21,title:'One Piece'}];assert.deepEqual(await mal.getDubbedMatches(entries),[]);
 fail=false;assert.equal((await mal.getDubbedMatches(entries))[0].id,'mal:21');
 assert.equal((await mal.getDubbedMatches(entries)).length,1);assert.equal(calls,2);
});
