import { resampleProfile } from "./wavetable.js?v=0.3.0";

export const BORE_REFERENCE_RELIEF_METERS = 1_000;
export const MINIMUM_BORE_SECTIONS = 4;
export const MAXIMUM_BORE_SECTIONS = 320;
export const MAXIMUM_REFLECTION = 0.96;
export const MINIMUM_LOOP_DELAY_SAMPLES = 1;
export const LOOP_DELAY_BUFFER_LENGTH = 2_048;
export const MOUTH_REFLECTION = -0.999;
export const BREATH_COLOUR = 0.12;
export const DC_BLOCK_POLE = 0.9975;

export const BORE_DEFAULTS = {
  depth: 2,
  decay: 0.85,
  tone: 0.89,
  blow: 0.5,
};

export const BORE_RANGES = {
  depth: { minimum: 0.25, maximum: 3 },
  decay: { minimum: 0, maximum: 1 },
  tone: { minimum: 0, maximum: 1 },
  blow: { minimum: 0, maximum: 1 },
};

const SHORTEST_END_REFLECTION = 0.955;
const LONGEST_END_REFLECTION = 0.9995;
const DARKEST_RADIATION = 0.25;
const BRIGHTEST_RADIATION = 0.98;
const LOUDEST_JET = 0.08;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function endReflectionFromDecay(decay) {
  const bounded = clamp(decay, 0, 1);
  return -(SHORTEST_END_REFLECTION + (LONGEST_END_REFLECTION - SHORTEST_END_REFLECTION) * bounded);
}

export function radiationFromTone(tone) {
  const bounded = clamp(tone, 0, 1);
  return DARKEST_RADIATION + (BRIGHTEST_RADIATION - DARKEST_RADIATION) * bounded;
}

export function jetFromBlow(blow) {
  const bounded = clamp(blow, 0, 1);
  return LOUDEST_JET * bounded * bounded;
}

export function boreSections(periodSamples, radiationCoefficient) {
  const radiationDelay = (1 - radiationCoefficient) / radiationCoefficient;
  const ladderTarget = (periodSamples - MINIMUM_LOOP_DELAY_SAMPLES - radiationDelay) / 2;
  return clamp(Math.floor(ladderTarget), MINIMUM_BORE_SECTIONS, MAXIMUM_BORE_SECTIONS);
}

/**
 * @param {Float32Array | Float64Array} elevationMeters
 * @param {{ sections?: number, depth?: number }} [parameters]
 */
export function boreFromProfile(elevationMeters, parameters = {}) {
  const sections = clamp(
    Math.round(parameters.sections ?? 48),
    MINIMUM_BORE_SECTIONS,
    MAXIMUM_BORE_SECTIONS,
  );
  const depth = clamp(parameters.depth ?? BORE_DEFAULTS.depth, BORE_RANGES.depth.minimum, BORE_RANGES.depth.maximum);
  const relief = resampleProfile(elevationMeters, sections);
  let sum = 0;
  for (const elevation of relief) sum += elevation;
  const meanElevationMeters = sum / relief.length;
  const areas = new Float64Array(sections);
  for (let index = 0; index < sections; index += 1) {
    areas[index] = Math.exp(
      (depth * (relief[index] - meanElevationMeters)) / BORE_REFERENCE_RELIEF_METERS,
    );
  }
  const coefficients = new Float64Array(sections - 1);
  let largestReflection = 0;
  for (let index = 0; index < sections - 1; index += 1) {
    const ratio = (areas[index] - areas[index + 1]) / (areas[index] + areas[index + 1]);
    coefficients[index] = clamp(ratio, -MAXIMUM_REFLECTION, MAXIMUM_REFLECTION);
    largestReflection = Math.max(largestReflection, Math.abs(coefficients[index]));
  }
  return {
    sections,
    depth,
    areas,
    coefficients,
    largestReflection,
    reliefMeters: relief,
    meanElevationMeters,
  };
}

export class BoreLadder {
  constructor(maximumSections = MAXIMUM_BORE_SECTIONS) {
    this.maximumSections = maximumSections;
    this.forward = new Float64Array(maximumSections);
    this.backward = new Float64Array(maximumSections);
    this.nextForward = new Float64Array(maximumSections);
    this.nextBackward = new Float64Array(maximumSections);
    this.coefficients = new Float64Array(maximumSections);
    this.delayLine = new Float64Array(LOOP_DELAY_BUFFER_LENGTH);
    this.delayIndex = 0;
    this.sections = 0;
    this.periodSamples = 0;
    this.loopDelaySamples = MINIMUM_LOOP_DELAY_SAMPLES;
    this.endReflection = endReflectionFromDecay(BORE_DEFAULTS.decay);
    this.radiationCoefficient = radiationFromTone(BORE_DEFAULTS.tone);
    this.radiationState = 0;
    this.blockerInput = 0;
    this.blockerOutput = 0;
  }

  setBore(coefficients, periodSamples) {
    const sections = Math.min(this.maximumSections, coefficients.length + 1);
    this.sections = sections;
    for (let index = 0; index < sections - 1; index += 1) {
      this.coefficients[index] = clamp(coefficients[index], -MAXIMUM_REFLECTION, MAXIMUM_REFLECTION);
    }
    this.periodSamples = periodSamples;
    this.refreshLoopDelay();
  }

  setLoop(endReflection, radiationCoefficient) {
    this.endReflection = clamp(endReflection, -MAXIMUM_REFLECTION - 0.04, 0);
    this.radiationCoefficient = clamp(radiationCoefficient, DARKEST_RADIATION, BRIGHTEST_RADIATION);
    this.refreshLoopDelay();
  }

  refreshLoopDelay() {
    const radiationDelay = (1 - this.radiationCoefficient) / this.radiationCoefficient;
    this.loopDelaySamples = clamp(
      this.periodSamples - 2 * this.sections - radiationDelay,
      MINIMUM_LOOP_DELAY_SAMPLES,
      LOOP_DELAY_BUFFER_LENGTH - 2,
    );
  }

  reset() {
    this.forward.fill(0);
    this.backward.fill(0);
    this.nextForward.fill(0);
    this.nextBackward.fill(0);
    this.delayLine.fill(0);
    this.delayIndex = 0;
    this.radiationState = 0;
    this.blockerInput = 0;
    this.blockerOutput = 0;
  }

  readDelay() {
    const position = this.delayIndex - this.loopDelaySamples + LOOP_DELAY_BUFFER_LENGTH;
    const base = Math.floor(position);
    const mix = position - base;
    const first = this.delayLine[base % LOOP_DELAY_BUFFER_LENGTH];
    const second = this.delayLine[(base + 1) % LOOP_DELAY_BUFFER_LENGTH];
    return first + (second - first) * mix;
  }

  process(input) {
    const sections = this.sections;
    if (sections < 2) return 0;
    const last = sections - 1;
    const delayed = this.readDelay();
    this.delayLine[this.delayIndex] = this.backward[0];
    this.delayIndex = (this.delayIndex + 1) % LOOP_DELAY_BUFFER_LENGTH;

    this.nextForward[0] = input + MOUTH_REFLECTION * delayed;
    for (let index = 0; index < last; index += 1) {
      const scatter = this.coefficients[index] * (this.forward[index] - this.backward[index + 1]);
      this.nextForward[index + 1] = this.forward[index] + scatter;
      this.nextBackward[index] = this.backward[index + 1] + scatter;
    }
    this.radiationState += this.radiationCoefficient * (this.forward[last] - this.radiationState);
    this.nextBackward[last] = this.endReflection * this.radiationState;

    const pressure = this.forward[last];
    this.blockerOutput = pressure - this.blockerInput + DC_BLOCK_POLE * this.blockerOutput;
    this.blockerInput = pressure;

    const swapForward = this.forward;
    const swapBackward = this.backward;
    this.forward = this.nextForward;
    this.backward = this.nextBackward;
    this.nextForward = swapForward;
    this.nextBackward = swapBackward;
    return this.blockerOutput;
  }
}

export class BreathNoise {
  constructor(seed = 0x9e3779b9) {
    this.state = seed >>> 0;
    this.filtered = 0;
  }

  next() {
    this.state = (Math.imul(this.state, 1_664_525) + 1_013_904_223) >>> 0;
    const white = (this.state / 0x1_0000_0000) * 2 - 1;
    this.filtered += BREATH_COLOUR * (white - this.filtered);
    return this.filtered;
  }
}

export const AGC_TARGET_RMS = 0.28;
export const AGC_FLOOR_RMS = 0.0004;
export const AGC_MINIMUM_GAIN = 0.25;
export const AGC_MAXIMUM_GAIN = 48;
export const AGC_LEVEL_SECONDS = 0.03;
export const AGC_GAIN_SECONDS = 0.2;

function poleFromSeconds(seconds, sampleRate) {
  return 1 - Math.exp(-1 / (Math.max(seconds, 1e-4) * sampleRate));
}

export class AutoLeveler {
  constructor(sampleRate, options = {}) {
    this.targetRms = options.targetRms ?? AGC_TARGET_RMS;
    this.floorRms = options.floorRms ?? AGC_FLOOR_RMS;
    this.minimumGain = options.minimumGain ?? AGC_MINIMUM_GAIN;
    this.maximumGain = options.maximumGain ?? AGC_MAXIMUM_GAIN;
    this.levelPole = poleFromSeconds(options.levelSeconds ?? AGC_LEVEL_SECONDS, sampleRate);
    this.gainPole = poleFromSeconds(options.gainSeconds ?? AGC_GAIN_SECONDS, sampleRate);
    this.meanSquare = 0;
    this.gain = 1;
  }

  process(sample) {
    this.meanSquare += this.levelPole * (sample * sample - this.meanSquare);
    const level = Math.sqrt(this.meanSquare);
    const targetGain = level > this.floorRms
      ? clamp(this.targetRms / level, this.minimumGain, this.maximumGain)
      : this.maximumGain;
    this.gain += this.gainPole * (targetGain - this.gain);
    return Math.tanh(sample * this.gain);
  }
}

/**
 * @param {Float64Array} coefficients
 * @param {{ sampleRate?: number, seconds?: number, periodSamples?: number, decay?: number, tone?: number }} [options]
 */
export function boreImpulseResponse(coefficients, options = {}) {
  const sampleRate = options.sampleRate ?? 44_100;
  const seconds = options.seconds ?? 1.5;
  const ladder = new BoreLadder();
  ladder.setLoop(
    endReflectionFromDecay(options.decay ?? BORE_DEFAULTS.decay),
    radiationFromTone(options.tone ?? BORE_DEFAULTS.tone),
  );
  ladder.setBore(coefficients, options.periodSamples ?? 2 * (coefficients.length + 1) + MINIMUM_LOOP_DELAY_SAMPLES);
  const response = new Float64Array(Math.round(seconds * sampleRate));
  for (let index = 0; index < response.length; index += 1) {
    response[index] = ladder.process(index === 0 ? 1 : 0);
  }
  return response;
}

export function firstResonanceHz(response, sampleRate = 44_100, lowestHz = 40, highestHz = 4_000, options = {}) {
  const window = Math.min(response.length, options.windowLength ?? 16_384);
  const step = options.stepHz ?? 0.5;
  let loudest = 0;
  const magnitudes = [];
  for (let hertz = lowestHz; hertz <= highestHz; hertz += step) {
    const angle = (2 * Math.PI * hertz) / sampleRate;
    const coefficient = 2 * Math.cos(angle);
    let first = 0;
    let second = 0;
    for (let index = 0; index < window; index += 1) {
      const current = response[index] + coefficient * first - second;
      second = first;
      first = current;
    }
    const magnitude = Math.sqrt(Math.max(0, first * first + second * second - coefficient * first * second));
    magnitudes.push({ hertz, magnitude });
    loudest = Math.max(loudest, magnitude);
  }
  const threshold = loudest * 0.25;
  for (let index = 2; index < magnitudes.length - 2; index += 1) {
    const point = magnitudes[index];
    if (point.magnitude < threshold) continue;
    if (
      point.magnitude > magnitudes[index - 1].magnitude
      && point.magnitude > magnitudes[index - 2].magnitude
      && point.magnitude >= magnitudes[index + 1].magnitude
      && point.magnitude >= magnitudes[index + 2].magnitude
    ) {
      return point.hertz;
    }
  }
  return 0;
}

export const TEMPER_REFERENCE_MIDI_NOTE = 69;
export const TEMPER_SEARCH_SEMITONES = 24;
export const TEMPER_ANALYSIS_WINDOW_SAMPLES = 4_096;
export const TEMPER_ANALYSIS_STEP_HZ = 1;
export const TEMPER_RECOMPUTE_THROTTLE_MS = 180;

export function boreTuningOffsetSemitones(elevationMeters, options = {}) {
  const sampleRate = options.sampleRate ?? 44_100;
  const depth = options.depth ?? BORE_DEFAULTS.depth;
  const tone = options.tone ?? BORE_DEFAULTS.tone;
  const decay = options.decay ?? BORE_DEFAULTS.decay;
  const referenceMidiNote = options.referenceMidiNote ?? TEMPER_REFERENCE_MIDI_NOTE;
  const targetHz = 440 * 2 ** ((referenceMidiNote - 69) / 12);
  const periodSamples = sampleRate / targetHz;
  const sections = boreSections(periodSamples, radiationFromTone(tone));
  const bore = boreFromProfile(elevationMeters, { sections, depth });
  const seconds = (TEMPER_ANALYSIS_WINDOW_SAMPLES + 256) / sampleRate;
  const response = boreImpulseResponse(bore.coefficients, { sampleRate, seconds, periodSamples, decay, tone });
  const measuredHz = firstResonanceHz(
    response,
    sampleRate,
    targetHz * 2 ** (-TEMPER_SEARCH_SEMITONES / 12),
    targetHz * 2 ** (TEMPER_SEARCH_SEMITONES / 12),
    { stepHz: TEMPER_ANALYSIS_STEP_HZ, windowLength: TEMPER_ANALYSIS_WINDOW_SAMPLES },
  );
  if (measuredHz <= 0) return 0;
  return 12 * Math.log2(measuredHz / targetHz);
}

export function reliefIsFlat(elevationMeters, epsilonMeters = 1e-6) {
  let minimumElevationMeters = Number.POSITIVE_INFINITY;
  let maximumElevationMeters = Number.NEGATIVE_INFINITY;
  for (const elevation of elevationMeters) {
    minimumElevationMeters = Math.min(minimumElevationMeters, elevation);
    maximumElevationMeters = Math.max(maximumElevationMeters, elevation);
  }
  return maximumElevationMeters - minimumElevationMeters <= epsilonMeters;
}
