const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module');
function service(fetch){const file=require.resolve('../services/animeworld');delete require.cache[file];const original=Module._load;Module._load=function(name,parent,...args){if(parent?.filename===file&&name==='node-fetch')return fetch;return original.call(this,name,parent,...args)};try{return require(file)}finally{Module._load=original}}
const card=(slug,dub=true)=>`<div class="item"><div class="${dub?'dub':'sub'}"></div><a class="name" href="/play/${slug}">Example (ITA)</a><img src="https://images.example/${slug}.jpg"></div>`;
const page=(cards,next='')=>`<form action="/filter"></form><div class="film-list">${cards}</div>${next}`;
const detail=(id,audio='Italiano')=>`<meta name="description" content="Example"><div class="widget info"><h2 class="title">Example</h2><dl class="meta"><dt>Categoria:</dt><dd>Anime</dd><dt>Audio:</dt><dd>${audio}</dd><dt>Data di Uscita:</dt><dd>2026</dd></dl></div><a href="https://myanimelist.net/anime/${id}/Example">MAL</a>`;
const html=text=>({ok:true,text:async()=>text});

test('archive parsing requires DUB cards and handles client-rendered full-page pagination',()=>{
 const aw=service(()=>{throw Error('unexpected network')});
 const parsed=aw.parseArchive(page(card('one')+card('sub',false),'<a href="/filter?dub=1&page=2">Next</a>'),1);
 assert.equal(parsed.records.length,1);assert.equal(parsed.records[0].id,'aw:one');assert.equal(parsed.hasNext,true);
 assert.equal(aw.parseArchive(page(Array.from({length:40},(_,i)=>card(`a${i}`)).join(''))+'<script>window.paginationMaxPage = parseInt("NaN");</script>',1).hasNext,true);
 assert.deepEqual(aw.parseArchive(page(''),2),{records:[],hasNext:false});
 assert.throws(()=>aw.parseArchive('<h1>Maintenance</h1>',1),/unavailable/);
});

test('archive follows pages, verifies Italian audio and external MAL IDs, and shares simultaneous scans',async()=>{
 const calls=[];
 const aw=service(async url=>{
  calls.push(url);
  if(url.includes('page=1'))return html(page(card('one')+card('not-dubbed'),'<a href="/filter?dub=1&page=2">Next</a>'));
  if(url.includes('page=2'))return html(page(card('two')));
  if(url.endsWith('/one'))return html(detail(1));if(url.endsWith('/two'))return html(detail(2));return html(detail(99,'Giapponese'));
 });
 const [a,b]=await Promise.all([aw.getDubbedArchive(),aw.getDubbedArchive()]);
 assert.deepEqual(a.records.map(r=>r.mal_id),['1','2']);assert.equal(a.complete,true);assert.deepEqual(b,a);
 assert.equal(calls.filter(u=>u.includes('/filter?')).length,2);
 await aw.getDubbedArchive();assert.equal(calls.length,5);
});

test('failed details and interrupted pages retain verified records and resume instead of caching emptiness',async()=>{
 let offline=true;
 const aw=service(async url=>{
  if(url.includes('page=1'))return html(page(card('one')+card('two')));
  if(url.endsWith('/two')&&offline)throw Error('offline');
  return html(detail(url.endsWith('/one')?1:2));
 });
 const first=await aw.getDubbedArchive();assert.equal(first.records.length,1);assert.equal(first.complete,false);
 offline=false;const second=await aw.getDubbedArchive();assert.equal(second.records.length,2);assert.equal(second.complete,true);
});

test('direct ranked searches require a DUB result, Italian audio and the exact MAL ID',async()=>{
 const aw=service(async url=>{
  if(url.includes('/search?'))return html(page(card('wrong-id')+card('correct')+card('sub',false)));
  if(url.endsWith('/wrong-id'))return html(detail(99));
  return html(detail(21));
 });
 const result=await aw.getDubbedMatches([{mal_id:21,title:'One Piece'}]);
 assert.equal(result.length,1);assert.equal(result[0].mal_id,'21');assert.equal(result[0].id,'aw:correct');assert.equal(result[0]._dubbed,true);
});

test('ranked searches prioritize the exact title ahead of similarly named specials',()=>{
 const aw=service(()=>{throw Error('unexpected network')});
 const text=page(Array.from({length:5},(_,i)=>card(`special-${i}`)).join('')+card('original').replace('Example (ITA)','One Piece (ITA)'));
 assert.equal(aw.parseSearch(text,'One Piece')[0],'https://www.animeworld.ac/play/original');
});

test('ranked scans resume beyond the first 40 and retain previous positives in MAL order',async()=>{
 const searched=[];
 const aw=service(async(url,options)=>{
  assert(options.timeout>5000);
  if(url.includes('/search?')){
   const id=Number(new URL(url).searchParams.get('keyword').split(' ')[1]);searched.push(id);
   return html(page(id===3||id===45?card(`title-${id}`):''));
  }
  return html(detail(Number(url.match(/title-(\d+)/)[1])));
 });
 const entries=Array.from({length:50},(_,i)=>({mal_id:i+1,title:`Title ${i+1}`}));
 assert.deepEqual((await aw.getDubbedMatches(entries)).map(r=>r.mal_id),['3']);
 assert.deepEqual((await aw.getDubbedMatches(entries)).map(r=>r.mal_id),['3','45']);
 assert(searched.includes(45));assert.equal(searched.filter(id=>id===3).length,1);
});

test('a timed out batch resumes at unstarted candidates instead of skipping them',async t=>{
 let now=100000;t.mock.method(Date,'now',()=>now);
 const searched=[];
 const aw=service(async url=>{
  if(url.includes('/search?')){
   const id=Number(new URL(url).searchParams.get('keyword'));searched.push(id);
   if(id<=6){now+=30000;throw Error('provider timeout');}
   return html(page(card(`title-${id}`)));
  }
  return html(detail(Number(url.match(/title-(\d+)/)[1])));
 });
 const entries=Array.from({length:10},(_,i)=>({mal_id:i+1,title:String(i+1)}));
 await aw.getDubbedMatches(entries);
 const firstCount=searched.length;
 await aw.getDubbedMatches(entries);
 assert.equal(searched[firstCount],firstCount+1);
});
