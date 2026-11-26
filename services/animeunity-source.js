const fetch = require("node-fetch");
const cheerio = require("cheerio");
const episodeNumber = require("./episode-numbers");

const BASE = "https://animeunity.cx";
const REQUEST_TIMEOUT_MS = 8000;
const RECENT_BUDGET_MS = 20000;
const TYPES = {
  tv: "TV", movie: "Movie", ova: "OVA", ona: "ONA",
  special: "Special", tv_special: "Special", music: "Music",
};

async function request(path, accept, deadline = Infinity) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("AnimeUnity request deadline exceeded");
  const response = await fetch(new URL(path, BASE).href, {
    headers: { Accept: accept, "User-Agent": "DubbedAnimeFeed" },
    timeout: Math.min(REQUEST_TIMEOUT_MS, remaining),
  });
  if (!response.ok) throw new Error(`AnimeUnity metadata HTTP ${response.status}`);
  return response;
}

async function page(path, params, deadline) {
  const response = await request(`${path}?${new URLSearchParams(params)}`, "application/json", deadline);
  const data = await response.json();
  if (!Array.isArray(data?.data) || !Number.isInteger(data.last_page) || data.last_page < 1) {
    throw new Error("Invalid AnimeUnity page");
  }
  return data;
}

function normalizeAnime(anime) {
  const type = TYPES[anime?.type];
  if (!Number.isSafeInteger(anime?.id) || !type) return null;
  return {
    id: anime.id,
    slug: anime.slug,
    mal_id: anime.mal_id,
    anilist_id: anime.anilist_id,
    title: anime.title,
    title_it: anime.title_it,
    title_eng: anime.title,
    plot: anime.plot,
    type,
    date: anime.year == null ? undefined : String(anime.year),
    score: anime.score == null ? undefined : String(anime.score),
    imageurl: anime.images?.poster,
    imageurl_cover: anime.images?.cover || anime.images?.banner,
  };
}

async function archivePage(query, number) {
  const filter = query ? { query } : { sort_by: "score" };
  return page("/api/archive", { language: "ita", ...filter, page: number });
}

async function getArchive(query, limit) {
  const first = await archivePage(query, 1);
  const last = Math.min(first.last_page, limit);
  const rows = [...first.data];
  const concurrency = query ? 3 : 6;
  let failure;
  for (let start = 2; start <= last; start += concurrency) {
    const numbers = Array.from({ length: Math.min(concurrency, last - start + 1) }, (_, index) => start + index);
    const pages = await Promise.allSettled(numbers.map(number => archivePage(query, number)));
    for (const result of pages) {
      if (result.status === "fulfilled") rows.push(...result.value.data);
      else failure = result.reason;
    }
    if (failure) break;
  }
  const records = rows
    .filter(anime => anime?.variants?.some(variant => variant.language === "ita" && variant.episodes_count > 0))
    .map(normalizeAnime)
    .filter(Boolean);
  if (failure && !records.length) throw failure;
  return { records, partial: Boolean(failure) };
}

const recentDetails = new Map();

async function resolveRecent(anime, deadline) {
  if (anime.mal_id || anime.anilist_id) return anime;
  const cached = recentDetails.get(anime.id);
  if (cached && Date.now() - cached.at < 12 * 60 * 60 * 1000) return cached.anime;
  if (!/^[\w-]+$/.test(anime.slug || "")) return null;
  const response = await request(`/anime/${anime.id}-${anime.slug}`, "text/html", deadline);
  const $ = cheerio.load(await response.text());
  const detail = JSON.parse($("[data-page]").first().attr("data-page") || "{}").props?.anime;
  if (detail?.id !== anime.id) throw new Error("AnimeUnity detail ID mismatch");
  const normalized = normalizeAnime(detail);
  if (normalized?.mal_id || normalized?.anilist_id) {
    if (recentDetails.size >= 500) recentDetails.delete(recentDetails.keys().next().value);
    recentDetails.set(anime.id, { anime: normalized, at: Date.now() });
    return normalized;
  }
  return null;
}

async function getRecent() {
  const deadline = Date.now() + RECENT_BUDGET_MS;
  const feedPage = number => page("/api/home/latest-episodes", { language: "dub", per_page: 20, page: number }, deadline);
  const first = await feedPage(1);
  const rows = [...first.data];
  const pages = Array.from({ length: Math.min(first.last_page - 1, 8) }, (_, index) => index + 2);
  const later = await Promise.allSettled(pages.map(feedPage));
  for (const result of later) if (result.status === "fulfilled") rows.push(...result.value.data);

  const records = new Map();
  for (const row of rows) {
    if (row?.language !== "ita" || row.is_hidden) continue;
    const anime = normalizeAnime(row.episode?.anime);
    if (!anime) continue;
    const number = episodeNumber(row.episode.number);
    if (!records.has(anime.id)) {
      records.set(anime.id, { ...anime, _confirmedDubbedEpisodes: [], _observedAt: Date.now() });
    }
    const episodes = records.get(anime.id)._confirmedDubbedEpisodes;
    if (number && !episodes.includes(number)) episodes.push(number);
  }
  const ordered = [...records.values()];
  const resolved = new Array(ordered.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, ordered.length) }, async () => {
    while (next < ordered.length && Date.now() < deadline) {
      const index = next++;
      const anime = ordered[index];
      try {
        const detail = await resolveRecent(anime, deadline);
        if (detail) resolved[index] = { ...anime, ...detail };
      } catch (_) { /* A missing detail does not invalidate other verified titles. */ }
    }
  }));
  const recent = resolved.filter(Boolean);
  if (!recent.length) throw new Error("AnimeUnity dubbed feed has no mapped titles");
  return recent;
}

async function getDubbedEpisodes(record, total) {
  if (!/^\d+$/.test(String(record.id))) return [];
  const deadline = Date.now() + 10000;
  const numbers = new Set();
  const count = Math.min(3600, Math.max(1, Number(total) || 0));
  for (let start = 1; start <= count && Date.now() < deadline;) {
    let data;
    try {
      const response = await request(`/api/anime/${record.id}/episodes?start=${start}`, "application/json", deadline);
      data = await response.json();
      if (!Array.isArray(data?.episodes) || data.start !== start || !Number.isInteger(data.tab_size) || data.tab_size <= 0) {
        throw new Error("Invalid AnimeUnity episode list");
      }
    } catch (error) {
      if (!numbers.size) throw error;
      break;
    }
    for (const episode of data.episodes) {
      const number = episodeNumber(episode?.number);
      if (number && episode.id && episode.videos?.some(video => video.id && video.language === "ita" && video.is_hidden === false)) {
        numbers.add(number);
      }
    }
    if (!data.episodes.length || start + data.tab_size > data.total) break;
    start += data.tab_size;
  }
  return [...numbers];
}

module.exports = { getRecent, getArchive, getDubbedEpisodes };
