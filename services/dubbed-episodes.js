const fetch = require("node-fetch");
const animeunity = require("./animeunity");
const animeworld = require("./animeworld");
const episodeNumber = require("./episode-numbers");
const debug = require("../debug");

const TTL = 10 * 60 * 1000;
const RETRY = 60 * 1000;
const availability = new Map();
const pending = new Map();

async function externalIds(kitsuId, sources) {
  const ids = {};
  for (const { record } of sources) {
    if (record.mal_id) ids.mal_id = record.mal_id;
    if (record.anilist_id) ids.anilist_id = record.anilist_id;
  }
  if (ids.mal_id || ids.anilist_id) return ids;
  // A client can reopen a cached catalog card after a server restart. Resolve
  // its exact external IDs rather than trusting a search match on title alone.
  try {
    const response = await fetch(`https://kitsu.io/api/edge/anime/${kitsuId}/mappings`, {
      headers: { Accept: "application/vnd.api+json" }, timeout: 5000,
    });
    if (!response.ok) throw new Error(`Kitsu mappings HTTP ${response.status}`);
    const json = await response.json();
    for (const mapping of json.data || []) {
      const attributes = mapping.attributes || {};
      if (attributes.externalSite === "myanimelist/anime") ids.mal_id = attributes.externalId;
      if (attributes.externalSite === "anilist/anime") ids.anilist_id = attributes.externalId;
    }
  } catch (error) {
    debug(`Dubbed episode identity unavailable: ${error.message}`);
  }
  return ids;
}

async function loadNumbers(kitsuId, info, total) {
  const sources = animeunity.getDubbedSources(kitsuId);
  const numbers = new Set();
  // Feed entries confirm only the actual episode numbers they contain.
  for (const { record } of sources) {
    if (record._dubbed === false || [false, 0, "0"].includes(record.dub)) continue;
    if (Date.now() - record._observedAt < TTL) {
      for (const value of record._confirmedDubbedEpisodes || []) {
        const number = episodeNumber(value);
        if (number) numbers.add(number);
      }
    }
  }
  const ids = await externalIds(kitsuId, sources);
  const awSource = sources.find((source) => source.source === "AnimeWorld");
  const auSources = sources.filter((source) => source.source === "AnimeUnity").slice(0, 2);
  const titles = [...(info.titles || []), ...sources.flatMap(({ record }) => [record.title_eng, record.title_it, record.title])].filter(Boolean);
  const requests = auSources.map(({ record }) => animeunity.getDubbedEpisodes(record, total));
  requests.push(animeworld.getDubbedEpisodes(awSource ? awSource.record : ids, titles));
  const results = await Promise.allSettled(requests);
  for (const result of results) {
    if (result.status === "fulfilled") {
      for (const value of result.value) {
        const number = episodeNumber(value);
        if (number) numbers.add(number);
      }
    } else debug(`Dubbed episode source unavailable: ${result.reason.message}`);
  }
  return numbers;
}

function getNumbers(kitsuId, info, total) {
  const key = String(kitsuId);
  const cached = availability.get(key);
  if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.numbers);
  if (!pending.has(key)) {
    const request = loadNumbers(key, info, total).then((numbers) => {
      if (availability.size >= 2000) availability.delete(availability.keys().next().value);
      // Unconfirmed/failed lookups retry quickly; they are never a negative
      // claim that an episode has no Italian dub.
      availability.set(key, { numbers, expiresAt: Date.now() + (numbers.size ? TTL : RETRY) });
      return numbers;
    }).finally(() => pending.delete(key));
    pending.set(key, request);
  }
  return pending.get(key);
}

async function annotateDubbedEpisodes(meta, kitsuId, info) {
  if (!Array.isArray(meta.videos) || !meta.videos.length || !/^\d+$/.test(String(kitsuId))) return meta;
  let confirmed;
  try {
    const total = Math.max(...meta.videos.map((video) => episodeNumber(video.episode) || 0));
    confirmed = await getNumbers(kitsuId, info, total);
  } catch (error) {
    debug(`Dubbed episode lookup failed: ${error.message}`);
    return meta;
  }
  if (!confirmed.size) return meta;
  return {
    ...meta,
    videos: meta.videos.map((video) => {
      const number = episodeNumber(video.episode);
      if (video.season !== 1 || video.id !== `kitsu:${kitsuId}:${number}` || !confirmed.has(number)) return video;
      const title = video.title || `Episodio ${number}`;
      return { ...video, title: /^\[ITA\](?:\s|$)/.test(title) ? title : `[ITA] ${title}` };
    }),
  };
}

module.exports = { annotateDubbedEpisodes };
