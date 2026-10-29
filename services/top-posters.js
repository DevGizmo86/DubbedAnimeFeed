// TOP Posters' banner endpoint supports plain Kitsu IDs. Images are requested
// by the client, using its User-Agent and the owner's dashboard banner settings.
// Do not log this URL: the provider authenticates with a key in its path.
function bannerUrl(key, kitsuId, fallback) {
  if (typeof key !== 'string' || !key.trim() || !/^\d+$/.test(String(kitsuId))) return null;
  const url = new URL(`https://api.top-posters.com/${encodeURIComponent(key.trim())}/kitsu/banner/${kitsuId}.jpg`);
  try {
    const alternative = new URL(fallback);
    if (alternative.protocol === 'https:' && !alternative.username && !alternative.password) url.searchParams.set('fallback_url', alternative.href);
  } catch (_) { /* No valid horizontal alternative available. */ }
  return url.href;
}
module.exports = { bannerUrl };
