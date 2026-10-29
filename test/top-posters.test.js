const test=require('node:test'),assert=require('node:assert/strict');
const {bannerUrl}=require('../services/top-posters');
test('TOP Posters URLs encode credentials as a single path segment and accept only safe HTTPS fallback URLs',()=>{
 const u=new URL(bannerUrl(' TP-secret/with?symbols# ',12,'https://media.kitsu.app/cover.jpg?size=large&v=2'));
 assert.equal(u.pathname,'/TP-secret%2Fwith%3Fsymbols%23/kitsu/banner/12.jpg');
 assert.equal(u.searchParams.get('fallback_url'),'https://media.kitsu.app/cover.jpg?size=large&v=2');
 for(const fallback of ['http://example.com/x','javascript:alert(1)','https://user:pass@example.com/x'])assert.equal(new URL(bannerUrl('TP-key',12,fallback)).searchParams.has('fallback_url'),false);
 assert.equal(bannerUrl('',12),null);assert.equal(bannerUrl('TP-key','../12'),null);
});
