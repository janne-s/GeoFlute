export const WAVETABLE_LENGTH = 2_048;
export const PROFILE_POINT_COUNT = WAVETABLE_LENGTH / 2 + 1;
export const DEFAULT_HARMONIC_LIMIT = 64;
export const SEAM_METHODS = ["forward-reverse-mirror", "direct-profile"];

const MAX_POSITION = 0.96;
const WAVETABLE_PEAK = 0.92;
const REFERENCE_RELIEF_METERS = 1_000;
const MINIMUM_NORMALIZED_RELIEF_METERS = 20;
const COSINE_TABLE = new Float64Array(WAVETABLE_LENGTH);
const SINE_TABLE = new Float64Array(WAVETABLE_LENGTH);

for (let index = 0; index < WAVETABLE_LENGTH; index += 1) {
  COSINE_TABLE[index] = Math.cos((2 * Math.PI * index) / WAVETABLE_LENGTH);
  SINE_TABLE[index] = Math.sin((2 * Math.PI * index) / WAVETABLE_LENGTH);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function bilinearElevation(terrain, eastMeters, northMeters) {
  const halfWidth = terrain.widthMeters / 2;
  const halfHeight = terrain.heightMeters / 2;
  const gridX = clamp(
    ((eastMeters + halfWidth) / terrain.widthMeters) * (terrain.size - 1),
    0,
    terrain.size - 1,
  );
  const gridY = clamp(
    ((halfHeight - northMeters) / terrain.heightMeters) * (terrain.size - 1),
    0,
    terrain.size - 1,
  );
  const x0 = Math.floor(gridX);
  const y0 = Math.floor(gridY);
  const x1 = Math.min(terrain.size - 1, x0 + 1);
  const y1 = Math.min(terrain.size - 1, y0 + 1);
  const mixX = gridX - x0;
  const mixY = gridY - y0;
  const northWest = terrain.elevationMeters[y0 * terrain.size + x0];
  const northEast = terrain.elevationMeters[y0 * terrain.size + x1];
  const southWest = terrain.elevationMeters[y1 * terrain.size + x0];
  const southEast = terrain.elevationMeters[y1 * terrain.size + x1];
  const north = northWest + (northEast - northWest) * mixX;
  const south = southWest + (southEast - southWest) * mixX;
  return north + (south - north) * mixY;
}

function clippedTransect(terrain, bearingDeg, position) {
  const radians = (bearingDeg * Math.PI) / 180;
  const direction = { x: Math.sin(radians), y: Math.cos(radians) };
  const normal = { x: -direction.y, y: direction.x };
  const halfWidth = terrain.widthMeters / 2;
  const halfHeight = terrain.heightMeters / 2;
  const support = Math.abs(normal.x) * halfWidth + Math.abs(normal.y) * halfHeight;
  const boundedPosition = clamp(position, -1, 1) * MAX_POSITION;
  const origin = {
    x: normal.x * support * boundedPosition,
    y: normal.y * support * boundedPosition,
  };
  let minimumT = Number.NEGATIVE_INFINITY;
  let maximumT = Number.POSITIVE_INFINITY;

  for (const axis of [
    { origin: origin.x, direction: direction.x, extent: halfWidth },
    { origin: origin.y, direction: direction.y, extent: halfHeight },
  ]) {
    if (Math.abs(axis.direction) < 1e-12) continue;
    const first = (-axis.extent - axis.origin) / axis.direction;
    const second = (axis.extent - axis.origin) / axis.direction;
    minimumT = Math.max(minimumT, Math.min(first, second));
    maximumT = Math.min(maximumT, Math.max(first, second));
  }

  const start = {
    eastMeters: origin.x + direction.x * minimumT,
    northMeters: origin.y + direction.y * minimumT,
  };
  const end = {
    eastMeters: origin.x + direction.x * maximumT,
    northMeters: origin.y + direction.y * maximumT,
  };
  return {
    start,
    end,
    bearingDeg: ((bearingDeg % 360) + 360) % 360,
    position: clamp(position, -1, 1),
    lengthMeters: Math.max(0, maximumT - minimumT),
  };
}

function extractProfile(terrain, transect, pointCount) {
  const elevationMeters = new Float32Array(pointCount);
  for (let index = 0; index < pointCount; index += 1) {
    const mix = index / (pointCount - 1);
    const eastMeters = transect.start.eastMeters
      + (transect.end.eastMeters - transect.start.eastMeters) * mix;
    const northMeters = transect.start.northMeters
      + (transect.end.northMeters - transect.start.northMeters) * mix;
    elevationMeters[index] = bilinearElevation(terrain, eastMeters, northMeters);
  }
  return elevationMeters;
}

function detrendProfile(elevationMeters) {
  const result = new Float64Array(elevationMeters.length);
  const first = elevationMeters[0];
  const difference = elevationMeters[elevationMeters.length - 1] - first;
  let sum = 0;
  for (let index = 0; index < elevationMeters.length; index += 1) {
    const trend = first + difference * (index / (elevationMeters.length - 1));
    result[index] = elevationMeters[index] - trend;
    sum += result[index];
  }
  const mean = sum / result.length;
  for (let index = 0; index < result.length; index += 1) result[index] -= mean;
  return result;
}

function mirroredCycle(profile) {
  const cycle = new Float64Array(WAVETABLE_LENGTH);
  const half = WAVETABLE_LENGTH / 2;
  for (let index = 0; index < half; index += 1) cycle[index] = profile[index];
  for (let index = half; index < WAVETABLE_LENGTH; index += 1) {
    cycle[index] = profile[WAVETABLE_LENGTH - index];
  }
  return cycle;
}

function bandLimitCycle(cycle, harmonicLimit, normalize) {
  if (cycle.length !== WAVETABLE_LENGTH) {
    throw new RangeError(`Cycle must be ${WAVETABLE_LENGTH} samples`);
  }
  const maximumHarmonic = Math.round(clamp(harmonicLimit, 1, WAVETABLE_LENGTH / 2 - 1));
  const real = new Float32Array(maximumHarmonic + 1);
  const imaginary = new Float32Array(maximumHarmonic + 1);
  const scale = 2 / WAVETABLE_LENGTH;

  for (let harmonic = 1; harmonic <= maximumHarmonic; harmonic += 1) {
    let cosine = 0;
    let sine = 0;
    for (let index = 0; index < WAVETABLE_LENGTH; index += 1) {
      const phase = (harmonic * index) % WAVETABLE_LENGTH;
      cosine += cycle[index] * COSINE_TABLE[phase];
      sine += cycle[index] * SINE_TABLE[phase];
    }
    real[harmonic] = cosine * scale;
    imaginary[harmonic] = sine * scale;
  }

  const waveform = new Float32Array(WAVETABLE_LENGTH);
  let peak = 0;
  for (let index = 0; index < WAVETABLE_LENGTH; index += 1) {
    let value = 0;
    for (let harmonic = 1; harmonic <= maximumHarmonic; harmonic += 1) {
      const phase = (harmonic * index) % WAVETABLE_LENGTH;
      value += real[harmonic] * COSINE_TABLE[phase] + imaginary[harmonic] * SINE_TABLE[phase];
    }
    waveform[index] = value;
    peak = Math.max(peak, Math.abs(value));
  }

  const fullScale = peak > 1e-9 ? WAVETABLE_PEAK / peak : 0;
  const reference = normalize ? MINIMUM_NORMALIZED_RELIEF_METERS : REFERENCE_RELIEF_METERS;
  const normalization = Math.min(fullScale, WAVETABLE_PEAK / reference);
  for (let index = 0; index < waveform.length; index += 1) waveform[index] *= normalization;
  for (let index = 0; index < real.length; index += 1) {
    real[index] *= normalization;
    imaginary[index] *= normalization;
  }
  return { waveform, real, imaginary, maximumHarmonic, isFlat: normalization === 0 };
}

/**
 * @param {import("./types.js").TerrainGrid} terrain
 * @param {{ bearingDeg?: number, position?: number, harmonicLimit?: number,
 *   seamMethod?: string, normalize?: boolean }} [parameters]
 */
export function buildTerrainWavetable(terrain, parameters = {}) {
  if (!terrain || terrain.size < 2 || terrain.elevationMeters.length !== terrain.size ** 2) {
    throw new RangeError("Terrain grid is missing or invalid");
  }
  const bearingDeg = parameters.bearingDeg ?? 90;
  const position = parameters.position ?? 0;
  const harmonicLimit = parameters.harmonicLimit ?? DEFAULT_HARMONIC_LIMIT;
  const seamMethod = parameters.seamMethod ?? SEAM_METHODS[0];
  const normalize = parameters.normalize ?? true;
  if (!SEAM_METHODS.includes(seamMethod)) {
    throw new RangeError(`Unsupported seam method: ${seamMethod}`);
  }
  const mirrored = seamMethod === "forward-reverse-mirror";
  const transect = clippedTransect(terrain, bearingDeg, position);
  const elevationMeters = extractProfile(
    terrain,
    transect,
    mirrored ? PROFILE_POINT_COUNT : WAVETABLE_LENGTH,
  );
  const detrendedMeters = detrendProfile(elevationMeters);
  const cycle = mirrored ? mirroredCycle(detrendedMeters) : detrendedMeters;
  const limited = bandLimitCycle(cycle, harmonicLimit, normalize);
  let minimumElevationMeters = Number.POSITIVE_INFINITY;
  let maximumElevationMeters = Number.NEGATIVE_INFINITY;
  for (const elevation of elevationMeters) {
    minimumElevationMeters = Math.min(minimumElevationMeters, elevation);
    maximumElevationMeters = Math.max(maximumElevationMeters, elevation);
  }

  return {
    ...limited,
    elevationMeters,
    detrendedMeters: Float32Array.from(detrendedMeters),
    transect,
    minimumElevationMeters,
    maximumElevationMeters,
    mapping: "experimental-direct-terrain-profile",
    seamMethod,
    normalized: normalize,
  };
}

/**
 * @param {import("./types.js").TerrainGrid} terrain
 * @param {object} parameters
 * @param {number} frames
 */
export function buildWavetableFrames(terrain, parameters = {}, options = {}) {
  const count = Math.max(1, Math.round(options.frames ?? 256));
  const stride = Math.max(1, Math.round(WAVETABLE_LENGTH / (options.frameSamples ?? WAVETABLE_LENGTH)));
  const cycleSamples = WAVETABLE_LENGTH / stride;
  const samples = new Float32Array(count * cycleSamples);
  let peak = 0;

  for (let index = 0; index < count; index += 1) {
    const position = count === 1 ? 0 : (index / (count - 1)) * 2 - 1;
    const wavetable = buildTerrainWavetable(terrain, { ...parameters, position });
    const offset = index * cycleSamples;
    for (let sample = 0; sample < cycleSamples; sample += 1) {
      const value = wavetable.waveform[sample * stride];
      samples[offset + sample] = value;
      peak = Math.max(peak, Math.abs(value));
    }
  }

  if (options.fitToPeak && peak > 1e-9) {
    const gain = WAVETABLE_PEAK / peak;
    for (let index = 0; index < samples.length; index += 1) samples[index] *= gain;
  }
  return samples;
}

/**
 * @param {import("./types.js").TerrainGrid} terrain
 * @param {{ bearingDeg?: number, frames?: number, pointCount?: number }} [parameters]
 */
export function terrainProfileBank(terrain, parameters = {}) {
  const bearingDeg = parameters.bearingDeg ?? 90;
  const frames = Math.max(2, Math.round(parameters.frames ?? 24));
  const pointCount = Math.max(8, Math.round(parameters.pointCount ?? 192));
  const profiles = [];
  let minimumElevationMeters = Number.POSITIVE_INFINITY;
  let maximumElevationMeters = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < frames; index += 1) {
    const position = (index / (frames - 1)) * 2 - 1;
    const transect = clippedTransect(terrain, bearingDeg, position);
    const elevationMeters = extractProfile(terrain, transect, pointCount);
    for (const elevation of elevationMeters) {
      minimumElevationMeters = Math.min(minimumElevationMeters, elevation);
      maximumElevationMeters = Math.max(maximumElevationMeters, elevation);
    }
    profiles.push({ position, elevationMeters });
  }
  return { profiles, minimumElevationMeters, maximumElevationMeters, bearingDeg };
}

export function midiNoteFrequency(midiNote) {
  return 440 * 2 ** ((midiNote - 69) / 12);
}

export function renderWavetableNote(wavetable, parameters = {}) {
  const sampleRate = parameters.sampleRate ?? 44_100;
  const durationSeconds = parameters.durationSeconds ?? 2;
  const midiNote = parameters.midiNote ?? 60;
  const attackSeconds = Math.max(0.001, parameters.attackSeconds ?? 0.02);
  const releaseSeconds = Math.max(0.001, parameters.releaseSeconds ?? 0.3);
  const gain = clamp(parameters.gain ?? 0.72, 0, 1);
  const sampleCount = Math.max(1, Math.round(sampleRate * durationSeconds));
  const samples = new Float32Array(sampleCount);
  const phaseIncrement = midiNoteFrequency(midiNote) * wavetable.waveform.length / sampleRate;
  let phase = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const first = Math.floor(phase) % wavetable.waveform.length;
    const second = (first + 1) % wavetable.waveform.length;
    const mix = phase - Math.floor(phase);
    const oscillator = wavetable.waveform[first]
      + (wavetable.waveform[second] - wavetable.waveform[first]) * mix;
    const time = index / sampleRate;
    const remaining = (samples.length - 1 - index) / sampleRate;
    const envelope = Math.min(1, time / attackSeconds, remaining / releaseSeconds);
    samples[index] = oscillator * Math.max(0, envelope) * gain;
    phase = (phase + phaseIncrement) % wavetable.waveform.length;
  }
  return {
    samples,
    sampleRate,
    audibleDurationSeconds: durationSeconds,
    midiNote,
    frequencyHz: midiNoteFrequency(midiNote),
  };
}
