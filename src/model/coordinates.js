const DEGREES = String.raw`\d{1,3}(?:[.,]\d+)?`;
const SIGNED_DOT_DEGREES = String.raw`-?\d{1,3}(?:\.\d+)?`;
const SIGNED_DEGREES = String.raw`-?\d{1,3}(?:[.,]\d+)?`;

const HEMISPHERE_DEGREES = new RegExp(
  `(${DEGREES})\\s*°?\\s*([NSEW])|([NSEW])\\s*(${DEGREES})\\s*°?`,
  "gi",
);

const MARKER_LATITUDE = new RegExp(`[?&]mlat=(${SIGNED_DOT_DEGREES})`, "i");
const MARKER_LONGITUDE = new RegExp(`[?&]mlon=(${SIGNED_DOT_DEGREES})`, "i");
const HASH_MAP_TRIPLE = new RegExp(
  `#map=\\d+(?:\\.\\d+)?/(${SIGNED_DOT_DEGREES})/(${SIGNED_DOT_DEGREES})`,
  "i",
);

const MAP_LINK_ANCHOR_PAIR = new RegExp(`@(${SIGNED_DOT_DEGREES}),\\s*(${SIGNED_DOT_DEGREES})`);
const MAP_LINK_QUERY_PAIR = new RegExp(
  `(?:[?&](?:q|query|ll|center|sll)=)(${SIGNED_DOT_DEGREES})(?:,|%20|\\s)+(${SIGNED_DOT_DEGREES})`,
  "i",
);
const DOT_DECIMAL_PAIR = new RegExp(
  `(?<![\\d.])(${SIGNED_DOT_DEGREES})\\s*°?\\s*[,;]\\s*(${SIGNED_DOT_DEGREES})\\s*°?(?![\\d.])`,
);
const SPACE_SEPARATED_PAIR = new RegExp(
  `^\\s*(${SIGNED_DEGREES})\\s*°?\\s+(${SIGNED_DEGREES})\\s*°?\\s*$`,
);
const SEMICOLON_SEPARATED_PAIR = new RegExp(
  `^\\s*(-?\\d{1,3},\\d+)\\s*°?\\s*;\\s*(-?\\d{1,3},\\d+)\\s*°?\\s*$`,
);

const LATITUDE_FIRST_PATTERNS = [
  HASH_MAP_TRIPLE,
  MAP_LINK_ANCHOR_PAIR,
  MAP_LINK_QUERY_PAIR,
  DOT_DECIMAL_PAIR,
  SPACE_SEPARATED_PAIR,
  SEMICOLON_SEPARATED_PAIR,
];

const degreeNumber = (text) => Number(text.replace(",", "."));

/** @param {unknown} position */
export function isValidCoordinate(position) {
  return Number.isFinite(position?.latitude) && Math.abs(position.latitude) <= 90
    && Number.isFinite(position?.longitude) && Math.abs(position.longitude) <= 180;
}

function markerCoordinates(text) {
  const latitude = text.match(MARKER_LATITUDE);
  const longitude = text.match(MARKER_LONGITUDE);
  if (!latitude || !longitude) return null;
  return { latitude: degreeNumber(latitude[1]), longitude: degreeNumber(longitude[1]) };
}

function hemisphereCoordinates(text) {
  let latitude = null;
  let longitude = null;
  for (const match of text.matchAll(HEMISPHERE_DEGREES)) {
    const value = degreeNumber(match[1] ?? match[4]);
    const hemisphere = (match[2] ?? match[3]).toUpperCase();
    const signed = hemisphere === "S" || hemisphere === "W" ? -value : value;
    if (hemisphere === "N" || hemisphere === "S") latitude ??= signed;
    else longitude ??= signed;
  }
  return latitude === null || longitude === null ? null : { latitude, longitude };
}

/**
 * @param {string} value
 * @returns {{ latitude: number, longitude: number } | null}
 */
export function parseCoordinates(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;

  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    decoded = text;
  }

  const tagged = hemisphereCoordinates(decoded);
  if (tagged && isValidCoordinate(tagged)) return tagged;

  const marked = markerCoordinates(decoded);
  if (marked && isValidCoordinate(marked)) return marked;

  for (const pattern of LATITUDE_FIRST_PATTERNS) {
    const match = decoded.match(pattern);
    if (!match) continue;
    const position = { latitude: degreeNumber(match[1]), longitude: degreeNumber(match[2]) };
    if (isValidCoordinate(position)) return position;
  }
  return null;
}
