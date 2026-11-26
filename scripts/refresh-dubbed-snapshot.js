const fs = require("node:fs/promises");
const path = require("node:path");
const { getArchive, getRecent } = require("../services/animeunity-source");

function metadata(record) {
  return {
    id: record.id, mal_id: record.mal_id, anilist_id: record.anilist_id,
    title: record.title, title_it: record.title_it || undefined,
    title_ja: record.title_ja || undefined, type: record.type, date: record.date,
    imageurl: record.imageurl,
  };
}

function recordsJson(records) {
  return "[\n" + records.map(record => "    " + JSON.stringify(record)).join(",\n") + "\n  ]";
}

async function refresh() {
  const [{ records, partial }, latest] = await Promise.all([getArchive("", 60), getRecent()]);
  const archive = [...new Map(records.filter(record => record.mal_id).map(record => [record.mal_id, metadata(record)])).values()];
  const recent = latest.map(metadata);
  if (partial || !archive.length || !recent.length) throw new Error("AnimeUnity did not return a usable archive and recent feed");
  const capturedAt = JSON.stringify(new Date().toISOString());
  const data = `{\n  "capturedAt": ${capturedAt},\n  "archive": ${recordsJson(archive)},\n  "recent": ${recordsJson(recent)}\n}\n`;
  const destination = path.join(__dirname, "../data/dubbed-snapshot.json");
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.writeFile(temporary, data);
  await fs.rename(temporary, destination);
  console.log(`Saved ${archive.length} verified archive titles and ${recent.length} recent titles`);
}

refresh().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
