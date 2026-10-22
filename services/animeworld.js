const fetch = require("node-fetch");
const cheerio = require("cheerio");
const debug = require("../debug");

// Only metadata is requested: homepage and title pages, never video servers.
const BASE = "https://www.animeworld.ac";
const UA = "Mozilla/5.0 (compatible; DubbedAnimeFeed/1.5.8)";
const DETAIL_TTL = 12 * 60 * 60 * 1000;
const details = new Map();
const pending = new Map();

async function html(url, timeout = 10000) {
  const response = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    timeout,
  });
  if (!response.ok) throw new Error(`AnimeWorld metadata error: ${response.status}`);
  return response.text();
}

function parseFeed(text) {
  const $ = cheerio.load(text);
  const section = $('.content[data-name="dub"]');
  if (!section.length) throw new Error("AnimeWorld dubbed feed is missing");
  const seen = new Set();
  const records = [];
  section.find(".film-list .item").each((_, element) => {
    const card = $(element);
    // Require the explicit DUB marker as well as the correct tab.
    if (!card.find(".dub").length) return;
    const link = card.find("a.name").first();
    const match = (link.attr("href") || "").match(/^\/play\/([^/?#]+)/);
    if (!match || seen.has(match[1])) return;
    seen.add(match[1]);
    records.push({
      id: `aw:${match[1]}`,
      _url: `${BASE}/play/${match[1]}`,
      title: link.text().trim(),
      imageurl: card.find("img").first().attr("src"),
      _latestEpisode: card.find(".ep").first().text().replace(/^\s*Ep\s*/i, "").trim(),
    });
  });
  if (!records.length) throw new Error("AnimeWorld dubbed feed is empty");
  return records.slice(0, 60);
}

function parseDetail(text) {
  const $ = cheerio.load(text);
  const externalId = (site) => {
    for (const element of $("a[href]").toArray()) {
      const href = $(element).attr("href");
      const match = href.match(new RegExp(`^https?://(?:www\\.)?${site}/anime/(\\d+)(?:[/#?]|$)`));
      if (match) return match[1];
    }
    return null;
  };
  const field = (label) => {
    const dt = $(".widget.info dl.meta dt").filter((_, e) => $(e).text().trim() === label).first();
    return dt.next("dd").text().trim();
  };
  const category = field("Categoria:");
  const types = { Anime: "TV", Movie: "Movie", OVA: "OVA", ONA: "ONA", Special: "Special", Music: "Music" };
  const mal_id = externalId("myanimelist\\.net");
  const anilist_id = externalId("anilist\\.co");
  if (!types[category] || (!mal_id && !anilist_id)) {
    throw new Error("AnimeWorld title metadata is missing or unrecognized");
  }
  const title = $(".widget.info h2.title").first().text().trim();
  const description = $('meta[name="description"]').attr("content") || "";
  const prefix = `Trama di ${title} ITA: `;
  return {
    mal_id, anilist_id, type: types[category],
    plot: description.startsWith(prefix) ? description.slice(prefix.length) : description,
    // This is the anime's release year, NOT the latest dubbed episode's date.
    date: field("Data di Uscita:").match(/\b(?:19|20)\d{2}\b/)?.[0],
    score: $(".widget.info .rating[data-value]").attr("data-value"),
  };
}

function getDetail(url, timeout) {
  const cached = details.get(url);
  if (cached && Date.now() - cached.at < DETAIL_TTL) return Promise.resolve(cached.value);
  if (!pending.has(url)) {
    const request = html(url, timeout).then(parseDetail).then((value) => {
      // Bound the process cache even when the feed changes for many months.
      if (details.size >= 1000) details.delete(details.keys().next().value);
      details.set(url, { value, at: Date.now() });
      return value;
    }).finally(() => pending.delete(url));
    pending.set(url, request);
  }
  return pending.get(url);
}

async function getDubbedRecords() {
  const deadline = Date.now() + 20000;
  const feed = parseFeed(await html(`${BASE}/`));
  const output = new Array(feed.length);
  let next = 0;
  // Bound requests and preserve homepage order regardless of response timing.
  await Promise.all(Array.from({ length: Math.min(6, feed.length) }, async () => {
    while (next < feed.length && Date.now() < deadline) {
      const index = next++;
      try {
        const { _url, ...record } = feed[index];
        output[index] = { ...record, ...await getDetail(_url, Math.max(1, Math.min(10000, deadline - Date.now()))) };
      } catch (error) {
        debug(`AnimeWorld title skipped: ${error.message}`);
      }
    }
  }));
  const records = output.filter(Boolean);
  if (!records.length) throw new Error("AnimeWorld title metadata unavailable");
  return records;
}

module.exports = { getDubbedRecords, parseFeed, parseDetail };
