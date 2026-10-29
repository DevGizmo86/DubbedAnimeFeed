const fetch = require("node-fetch");
const cheerio = require("cheerio");
const debug = require("../debug");
const episodeNumber = require("./episode-numbers");

// Only metadata is requested: homepage and title pages, never video servers.
const BASE = "https://www.animeworld.ac";
const UA = "Mozilla/5.0 (compatible; DubbedAnimeFeed/1.5.15)";
const DETAIL_TTL = 12 * 60 * 60 * 1000;
const details = new Map();
const pending = new Map();
const episodeDetails = new Map();
const EPISODE_TTL = 10 * 60 * 1000;
let archive = null;
let archivePending = null;
const ARCHIVE_TTL = 12 * 60 * 60 * 1000;

function parseArchive(text, page) {
  const $ = cheerio.load(text);
  const cards = $(".film-list .item");
  if (!cards.length) {
    if ($('.film-list').length && $('form[action="/filter"]').length) return { records: [], hasNext: false };
    throw new Error("AnimeWorld dubbed archive is unavailable or unrecognized");
  }
  const records = [];
  cards.each((_, element) => {
    const card = $(element);
    if (!card.find(".dub").length) return;
    const link = card.find("a.name").first();
    const slug = (link.attr("href") || "").match(/^\/play\/([\w.-]+)$/)?.[1];
    if (!slug) return;
    records.push({ id: `aw:${slug}`, _url: `${BASE}/play/${slug}`, title: link.text().trim(), imageurl: card.find("img").first().attr("src") });
  });
  if (!records.length) throw new Error("AnimeWorld archive did not return dubbed records");
  const linkedNext = $("a[href]").toArray().some(a => {
    try {
      const url = new URL($(a).attr("href"), BASE);
      return url.origin === BASE && url.pathname === "/filter" && Number(url.searchParams.get("page")) === page + 1;
    } catch (_) { return false; }
  });
  // The live page also builds pagination in JS, sometimes with maxPage=NaN.
  // In that case follow full 40-card pages until a verified empty/short page.
  const maxPage = Number(text.match(/paginationMaxPage\s*=\s*parseInt\("(\d+)"\)/)?.[1]);
  const hasNext = linkedNext || (maxPage > 0 ? page < maxPage : cards.length >= 40);
  return { records, hasNext };
}

async function loadDubbedArchive() {
  if (!archive || Date.now() - archive.at >= ARCHIVE_TTL) {
    archive = { at: Date.now(), page: 1, queue: [], failed: [], records: new Map(), seen: new Set(), lastPage: false, complete: false };
  }
  const state = archive;
  if (state.complete) return { records: [...state.records.values()], complete: true };
  // Work is bounded per request; retain the cursor and unfinished records so
  // later refreshes continue rather than repeatedly scanning the first page.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !state.complete) {
    if (!state.queue.length) {
      if (state.lastPage) {
        state.complete = !state.failed.length;
        state.queue.push(...state.failed.splice(0));
        if (!state.queue.length) break;
      } else {
        let result;
        try {
          const page = await html(`${BASE}/filter?dub=1&sort=7&page=${state.page}`, Math.min(5000, Math.max(1, deadline - Date.now())));
          result = parseArchive(page, state.page);
          state.page++;
        } catch (error) {
          if (state.records.size) break;
          throw error;
        }
        let added = 0;
        for (const record of result.records) {
          if (!state.seen.has(record.id)) { state.seen.add(record.id); state.queue.push(record); added++; }
        }
        state.lastPage = !result.hasNext || state.page > 60 || !added;
      }
    }
    const batch = state.queue.splice(0, 6);
    if (!batch.length) continue;
    await Promise.all(batch.map(async ({ _url, ...record }) => {
      try {
        const detail = await getDetail(_url, Math.min(5000, Math.max(1, deadline - Date.now())));
        // DUB on the list and Italian audio on the detail page are both required.
        if (detail._dubbed && detail.mal_id) state.records.set(record.id, { ...record, ...detail, _source: "AnimeWorld" });
      } catch (_) { state.failed.push({ ...record, _url }); }
    }));
    // Failed details are retried on the next refresh, not in a hot loop.
    if (!state.queue.length && state.lastPage) {
      state.complete = !state.failed.length;
      break;
    }
  }
  if (!state.records.size) throw new Error("AnimeWorld dubbed archive has no verified records yet");
  return { records: [...state.records.values()], complete: state.complete };
}

function getDubbedArchive() {
  if (!archivePending) archivePending = loadDubbedArchive().finally(() => { archivePending = null; });
  return archivePending;
}

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
    if (!match) return;
    const number = episodeNumber(card.find(".ep").first().text().replace(/^\s*Ep\s*/i, ""));
    if (seen.has(match[1])) {
      const previous = records.find((record) => record.id === `aw:${match[1]}`);
      if (number && !previous._confirmedDubbedEpisodes.includes(number)) previous._confirmedDubbedEpisodes.push(number);
      return;
    }
    seen.add(match[1]);
    records.push({
      id: `aw:${match[1]}`,
      _url: `${BASE}/play/${match[1]}`,
      title: link.text().trim(),
      imageurl: card.find("img").first().attr("src"),
      _latestEpisode: card.find(".ep").first().text().replace(/^\s*Ep\s*/i, "").trim(),
      _confirmedDubbedEpisodes: number ? [number] : [],
      _observedAt: Date.now(),
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
  // The title suffix alone is insufficient: require the actual audio field.
  const dubbed = field("Audio:").toLowerCase() === "italiano";
  const episodes = new Set();
  if (dubbed) {
    $("ul.episodes li.episode a[data-episode-num][href]").each((_, element) => {
      const number = episodeNumber($(element).attr("data-episode-num"));
      if (number && /^\/play\/[^/]+\/[^/?#]+$/.test($(element).attr("href") || "")) episodes.add(number);
    });
  }
  return {
    mal_id, anilist_id, type: types[category],
    plot: description.startsWith(prefix) ? description.slice(prefix.length) : description,
    // This is the anime's release year, NOT the latest dubbed episode's date.
    date: field("Data di Uscita:").match(/\b(?:19|20)\d{2}\b/)?.[0],
    score: $(".widget.info .rating[data-value]").attr("data-value"),
    _dubbed: dubbed,
    _dubbedEpisodes: [...episodes],
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
      rememberEpisodes(url, value);
      return value;
    }).finally(() => pending.delete(url));
    pending.set(url, request);
  }
  return pending.get(url);
}

function rememberEpisodes(url, value) {
  if (episodeDetails.size >= 1000) episodeDetails.delete(episodeDetails.keys().next().value);
  episodeDetails.set(url, { value, at: Date.now() });
}

function matchesExternalId(detail, expected) {
  const keys = ["mal_id", "anilist_id"].filter((key) => expected[key] && detail[key]);
  // Reject contradictory IDs even when the title text happens to match.
  return keys.length > 0 && keys.every((key) => String(expected[key]) === String(detail[key]));
}

function parseSearch(text, title = null) {
  const $ = cheerio.load(text);
  const urls = new Map();
  const norm = value => String(value || "").replace(/\s*\(ITA\)\s*$/i, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  $(".film-list .item").each((_, element) => {
    const card = $(element);
    if (!card.find(".dub").length) return;
    const match = (card.find("a.name").attr("href") || "").match(/^\/play\/([^/?#]+)$/);
    if (match) {
      const exact = title && [card.find("a.name").text(), card.find("a.name").attr("data-jtitle")].some(value => value && norm(value) === norm(title));
      urls.set(`${BASE}/play/${match[1]}`, exact ? 1 : 0);
    }
  });
  return [...urls].sort((a,b) => b[1]-a[1]).slice(0,4).map(([url])=>url);
}

const rankedMatches = new Map();
const rankedPending = new Map();
async function findRankedDub(entry, timeout) {
  const id = String(entry.mal_id || "");
  if (!/^\d+$/.test(id) || !entry.title) return null;
  const hit = rankedMatches.get(id);
  if (hit && Date.now() - hit.at < (hit.record ? DETAIL_TTL : 60000)) return hit.record;
  if (!rankedPending.has(id)) {
    rankedPending.set(id, (async () => {
      const urls = parseSearch(await html(`${BASE}/search?keyword=${encodeURIComponent(entry.title)}`, timeout), entry.title);
      const results = await Promise.allSettled(urls.map(async url => {
        const detail = await getDetail(url, timeout);
        if (!detail._dubbed || String(detail.mal_id) !== id) return null;
        const slug = new URL(url).pathname.slice("/play/".length);
        return { ...detail, id: `aw:${slug}`, title: entry.title, _source: "AnimeWorld" };
      }));
      const record = results.find(r => r.status === "fulfilled" && r.value)?.value || null;
      if (record || results.every(r => r.status === "fulfilled")) {
        if (rankedMatches.size >= 1000) rankedMatches.delete(rankedMatches.keys().next().value);
        rankedMatches.set(id, { record, at: Date.now() });
      }
      return record;
    })().catch(() => null).finally(() => rankedPending.delete(id)));
  }
  return rankedPending.get(id);
}

async function getDubbedMatches(entries) {
  const candidates = entries.slice(0, 40);
  const output = new Array(candidates.length);
  const deadline = Date.now() + 20000;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, candidates.length) }, async () => {
    while (next < candidates.length && Date.now() < deadline) {
      const i = next++;
      output[i] = await findRankedDub(candidates[i], Math.min(5000, Math.max(1, deadline - Date.now())));
    }
  }));
  return output.filter(Boolean);
}

async function getDubbedEpisodes(record, titles = []) {
  const deadline = Date.now() + 10000;
  const read = async (url) => {
    const cached = episodeDetails.get(url);
    if (cached && Date.now() - cached.at < EPISODE_TTL) return cached.value;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("AnimeWorld episode lookup timed out");
    const value = parseDetail(await html(url, Math.min(5000, remaining)));
    rememberEpisodes(url, value);
    return value;
  };
  if (record.id && /^aw:[\w.-]+$/.test(String(record.id))) {
    const value = await read(`${BASE}/play/${String(record.id).slice(3)}`);
    return value._dubbed && matchesExternalId(value, record) ? value._dubbedEpisodes : [];
  }
  if (!record.mal_id && !record.anilist_id) return [];
  const query = titles.find((title) => typeof title === "string" && title.trim());
  if (!query) return [];
  const urls = parseSearch(await html(`${BASE}/search?keyword=${encodeURIComponent(query.replace(/\s*\(ITA\)\s*$/i, "").trim())}`, 5000));
  const results = await Promise.allSettled(urls.map(read));
  const numbers = new Set();
  for (const result of results) {
    if (result.status === "fulfilled" && result.value._dubbed && matchesExternalId(result.value, record)) {
      result.value._dubbedEpisodes.forEach((number) => numbers.add(number));
    }
  }
  return [...numbers];
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

module.exports = { getDubbedRecords, getDubbedArchive, getDubbedMatches, getDubbedEpisodes, parseFeed, parseDetail, parseSearch, parseArchive, episodeNumber };
