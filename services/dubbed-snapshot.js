const snapshot = require("../data/dubbed-snapshot.json");

const RECENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function getRecent() {
  const age = Date.now() - Date.parse(snapshot.capturedAt);
  return age >= 0 && age < RECENT_MAX_AGE_MS ? snapshot.recent : [];
}

module.exports = { archive: snapshot.archive, capturedAt: snapshot.capturedAt, getRecent };
