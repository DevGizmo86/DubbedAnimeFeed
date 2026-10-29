const fetch = require('node-fetch');
const cheerio = require('cheerio');
const TTL = 12 * 60 * 60 * 1000;
const cache = new Map(), pending = new Map(), scans = new Map();
const status = { attempted: 0, verified: 0, failures: 0 };
let nextRequest = 0;

// A credited Italian performer confirms a dub exists, never episode coverage.
// Ignore the language selector itself: it lists Italian even without credits.
function parseItalianCast(text, entry) {
  const $ = cheerio.load(text);
  const url = $('meta[property="og:url"]').attr('content') || '';
  if (!url.startsWith(`https://myanimelist.net/anime/${entry.mal_id}/`) || !$('.js-anime-character-language').length) {
    throw Error('MyAnimeList cast page unavailable or mismatched');
  }
  const italian = $('.js-anime-character-language').toArray().some(element => {
    const cell = $(element).parent();
    return $(element).text().trim() === 'Italian' && cell.find('a[href]').toArray().some(a => /^https:\/\/myanimelist\.net\/people\/\d+\//.test($(a).attr('href') || ''));
  });
  if (!italian) return null;
  const type = $('span.dark_text').filter((_, e) => $(e).text().trim() === 'Type:').parent().text().replace(/^\s*Type:\s*/, '').trim();
  if (!['TV','Movie','OVA','ONA','Special','TV Special','Music'].includes(type)) throw Error('Unknown MAL anime type');
  return { id: `mal:${entry.mal_id}`, mal_id: entry.mal_id, title: entry.title, type: type === 'TV Special' ? 'Special' : type,
    imageurl: $('meta[property="og:image"]').attr('content'), _dubbed: true, _source: 'MyAnimeList cast' };
}
async function lookup(entry, deadline) {
  const id=String(entry.mal_id), hit=cache.get(id);
  if(hit && Date.now()-hit.at<(hit.record?TTL:60000)) return hit.record;
  if(!pending.has(id)) {
    pending.set(id,(async()=>{
      const wait=Math.max(0,nextRequest-Date.now());nextRequest=Math.max(nextRequest,Date.now())+750;
      if(Date.now()+wait>=deadline)return null;
      if(wait)await new Promise(r=>setTimeout(r,wait));
      status.attempted++;
      const response=await fetch(`https://myanimelist.net/anime/${id}/_/characters`,{headers:{'User-Agent':'Mozilla/5.0',Accept:'text/html'},timeout:Math.min(12000,Math.max(1,deadline-Date.now()))});
      if(!response.ok)throw Error(`MAL cast HTTP ${response.status}`);
      const record=parseItalianCast(await response.text(),entry);
      if(cache.size>=1500)cache.delete(cache.keys().next().value);
      cache.set(id,{record,at:Date.now()});if(record)status.verified++;
      return record;
    })().catch(()=>{status.failures++;return null}).finally(()=>pending.delete(id)));
  }
  return pending.get(id);
}
async function getDubbedMatches(entries) {
  const key=entries.map(e=>e.mal_id).join(',');
  if(!scans.has(key)) {if(scans.size>=4)scans.delete(scans.keys().next().value);scans.set(key,{cursor:0,pending:null});}
  const state=scans.get(key);
  if(!state.pending)state.pending=(async()=>{
    const deadline=Date.now()+20000;let visited=0;
    await Promise.all(Array.from({length:Math.min(2,entries.length)},async()=>{
      while(visited<entries.length && Date.now()<deadline){
        visited++;const entry=entries[state.cursor++%entries.length];await lookup(entry,deadline);
      }
    }));
  })().finally(()=>state.pending=null);
  await state.pending;
  return entries.map(e=>cache.get(String(e.mal_id))).filter(hit=>hit?.record&&Date.now()-hit.at<TTL).map(hit=>hit.record);
}
function getStatus(){return {...status,cached:cache.size};}
module.exports={getDubbedMatches,parseItalianCast,getStatus};
