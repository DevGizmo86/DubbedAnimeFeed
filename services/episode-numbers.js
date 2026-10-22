// Only exact positive integer episode numbers can match kitsu:<id>:<number>.
// Specials, ranges and fractions need an explicit mapping and stay unmarked.
module.exports = function episodeNumber(value) {
  const text = String(value ?? "").trim();
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;
};
