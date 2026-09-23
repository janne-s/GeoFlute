import { isValidCoordinate, parseCoordinates } from "../model/coordinates.js?v=0.4.1";

const SERVICE_URL = "https://nominatim.openstreetmap.org/search";
const CACHE_PREFIX = "geoflute-place:";
const MINIMUM_REQUEST_INTERVAL_MS = 1_000;

let lastRequestAt = 0;

function readCache(key) {
  try {
    const cached = sessionStorage.getItem(key);
    const position = cached ? JSON.parse(cached) : null;
    return isValidCoordinate(position) ? position : null;
  } catch {
    return null;
  }
}

function writeCache(key, position) {
  try {
    sessionStorage.setItem(key, JSON.stringify(position));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} query
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ latitude: number, longitude: number } | null>}
 */
export async function findPlace(query, options = {}) {
  const text = query.trim();
  if (!text) return null;

  const coordinates = parseCoordinates(text);
  if (coordinates) return coordinates;

  const cacheKey = `${CACHE_PREFIX}${text.toLocaleLowerCase()}`;
  const cached = readCache(cacheKey);
  if (cached) return cached;

  const wait = Math.max(0, MINIMUM_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();

  const url = new URL(SERVICE_URL);
  url.search = new URLSearchParams({
    q: text,
    format: "jsonv2",
    limit: "1",
    "accept-language": "en",
  }).toString();

  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: options.signal });
  if (!response.ok) throw new Error("PLACE SEARCH UNAVAILABLE");
  const [result] = await response.json();
  if (!result) return null;

  const position = { latitude: Number(result.lat), longitude: Number(result.lon) };
  if (!isValidCoordinate(position)) return null;
  writeCache(cacheKey, position);
  return position;
}
