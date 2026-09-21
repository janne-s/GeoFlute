import { SEAM_METHODS } from "./wavetable.js";

export const PATCH_FORMAT = "geoflute-patch";
export const PATCH_SCHEMA_VERSION = 1;

const RANGES = {
  bearingDeg: { minimum: 0, maximum: 359, fallback: 90 },
  bankPosition: { minimum: -1, maximum: 1, fallback: 0 },
  harmonicLimit: { minimum: 8, maximum: 256, fallback: 64 },
  attackSeconds: { minimum: 0.003, maximum: 1, fallback: 0.02 },
  releaseSeconds: { minimum: 0.02, maximum: 2, fallback: 0.3 },
  scanRateHz: { minimum: 0.02, maximum: 2, fallback: 0.2 },
  scanDepth: { minimum: 0, maximum: 1, fallback: 1 },
  scanSmooth: { minimum: 0, maximum: 1, fallback: 0.3 },
  octaveOffset: { minimum: -3, maximum: 3, fallback: 0 },
  zoom: { minimum: 1, maximum: 14, fallback: 9 },
};

function bounded(value, range) {
  if (!Number.isFinite(value)) return range.fallback;
  return Math.min(range.maximum, Math.max(range.minimum, value));
}

function validBounds(value) {
  return Boolean(value)
    && [value.west, value.south, value.east, value.north].every(Number.isFinite)
    && value.west < value.east
    && value.south < value.north
    && value.west >= -180 && value.east <= 180
    && value.south >= -85.05112878 && value.north <= 85.05112878;
}

export function createPatch(state) {
  return {
    format: PATCH_FORMAT,
    schemaVersion: PATCH_SCHEMA_VERSION,
    name: "GeoFlute terrain wavetable",
    application: { version: "0.3.0", exportedAt: new Date().toISOString() },
    provenance: "SIMULATED",
    disclaimer: "Direct terrain-profile mapping for musical synthesis; not an environmental sound recording or physical simulation.",
    geometry: {
      bounds: state.selection,
      widthMeters: state.widthMeters,
      heightMeters: state.heightMeters,
      provider: state.provider,
      nativeResolutionMeters: state.resolutionMeters,
      gridSize: state.gridSize,
      elevationRangeMeters: state.elevationRangeMeters,
    },
    view: state.view,
    cycle: {
      mapping: "experimental-direct-terrain-profile",
      bearingDeg: state.bearingDeg,
      bankPosition: state.bankPosition,
      harmonicLimit: state.harmonicLimit,
      seamMethod: state.seamMethod,
      normalized: state.normalized,
      cycleSamples: state.cycleSamples,
      pitchMapping: "midi-equal-temperament-a4-440",
      octaveOffset: state.octaveOffset,
      envelope: { attackSeconds: state.attackSeconds, releaseSeconds: state.releaseSeconds },
    },
    scan: {
      rateHz: state.scanRateHz,
      depth: state.scanDepth,
      smooth: state.scanSmooth,
    },
    seed: state.seed,
  };
}

export function parsePatch(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The selected file is not valid JSON.");
  }
  if (value?.format !== PATCH_FORMAT) throw new Error("The selected file is not a GeoFlute patch.");
  if (!validBounds(value.geometry?.bounds)) throw new Error("The patch has no usable area bounds.");

  const bounds = value.geometry.bounds;
  const cycle = value.cycle ?? {};
  const scan = value.scan ?? {};
  const envelope = cycle.envelope ?? {};
  const view = value.view ?? {};

  return {
    selection: {
      west: bounds.west,
      south: bounds.south,
      east: bounds.east,
      north: bounds.north,
    },
    view: {
      longitude: Number.isFinite(view.longitude)
        ? view.longitude
        : (bounds.west + bounds.east) / 2,
      latitude: Number.isFinite(view.latitude)
        ? view.latitude
        : (bounds.south + bounds.north) / 2,
      zoom: bounded(view.zoom, RANGES.zoom),
    },
    bearingDeg: Math.round(bounded(cycle.bearingDeg, RANGES.bearingDeg)),
    bankPosition: bounded(cycle.bankPosition, RANGES.bankPosition),
    harmonicLimit: Math.round(bounded(cycle.harmonicLimit, RANGES.harmonicLimit)),
    seamMethod: SEAM_METHODS.includes(cycle.seamMethod) ? cycle.seamMethod : SEAM_METHODS[0],
    normalized: cycle.normalized !== false,
    octaveOffset: Math.round(bounded(cycle.octaveOffset, RANGES.octaveOffset)),
    attackSeconds: bounded(envelope.attackSeconds, RANGES.attackSeconds),
    releaseSeconds: bounded(envelope.releaseSeconds, RANGES.releaseSeconds),
    scanRateHz: bounded(scan.rateHz, RANGES.scanRateHz),
    scanDepth: bounded(scan.depth, RANGES.scanDepth),
    scanSmooth: bounded(scan.smooth, RANGES.scanSmooth),
  };
}
