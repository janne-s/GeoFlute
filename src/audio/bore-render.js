import { midiNoteFrequency } from "../model/wavetable.js?v=0.4.1";
import { boreFromProfile, boreSections, boreTuningOffsetSemitones, reliefIsFlat } from "../model/bore.js?v=0.4.1";

const WORKLET_URL = new URL("./bore-worklet.js?v=0.4.1", import.meta.url);
const VOICE_PEAK = 0.85;
export const EXPORT_SUSTAIN_SECONDS = 2;
export const EXPORT_TAIL_SECONDS = 1;

/**
 * @param {{ left: Float32Array, right: Float32Array | null }} profiles
 * @param {number[]} midiNotes
 * @param {{ depth: number, decay: number, tone: number, blow: number, width: number, temper: boolean }} parameters
 */
export async function renderBoreMultisample(profiles, midiNotes, parameters, options = {}) {
  const sampleRate = options.sampleRate ?? 44_100;
  const attackSeconds = options.attackSeconds ?? 0.02;
  const releaseSeconds = options.releaseSeconds ?? 0.3;
  const stereo = Boolean(profiles.right) && parameters.width > 0;
  const measure = (elevationMeters) => (parameters.temper
    ? boreTuningOffsetSemitones(elevationMeters, {
      sampleRate,
      depth: parameters.depth,
      tone: parameters.tone,
      decay: parameters.decay,
    })
    : 0);
  const offsets = { left: measure(profiles.left) };
  offsets.right = stereo ? measure(profiles.right) : offsets.left;
  const renders = [];
  for (const midiNote of midiNotes) {
    renders.push({
      midiNote,
      channels: await renderNote(profiles, midiNote, parameters, offsets, {
        sampleRate,
        attackSeconds,
        releaseSeconds,
        stereo,
      }),
    });
  }
  return renders;
}

function ladderForProfile(elevationMeters, naivePeriodSamples, parameters, offsetSemitones) {
  const sections = boreSections(naivePeriodSamples);
  const bore = boreFromProfile(elevationMeters, { sections, depth: parameters.depth });
  return {
    coefficients: bore.coefficients,
    periodSamples: offsetSemitones
      ? naivePeriodSamples * 2 ** (offsetSemitones / 12)
      : naivePeriodSamples,
  };
}

async function renderNote(profiles, midiNote, parameters, offsets, options) {
  const { sampleRate, attackSeconds, releaseSeconds, stereo } = options;
  const totalSeconds = EXPORT_SUSTAIN_SECONDS + releaseSeconds + EXPORT_TAIL_SECONDS;
  const channelCount = stereo ? 2 : 1;
  const context = new OfflineAudioContext(
    channelCount,
    Math.ceil(totalSeconds * sampleRate),
    sampleRate,
  );
  await context.audioWorklet.addModule(WORKLET_URL);

  const naivePeriodSamples = sampleRate / midiNoteFrequency(midiNote);
  const left = ladderForProfile(profiles.left, naivePeriodSamples, parameters, offsets.left);
  const right = stereo
    ? ladderForProfile(profiles.right, naivePeriodSamples, parameters, offsets.right)
    : null;

  const master = context.createGain();
  const highPass = context.createBiquadFilter();
  const limiter = context.createDynamicsCompressor();
  highPass.type = "highpass";
  highPass.frequency.value = 18;
  limiter.threshold.value = -7;
  limiter.knee.value = 3;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.12;
  master.gain.value = 0.55;
  master.connect(highPass).connect(limiter).connect(context.destination);

  const node = new AudioWorkletNode(context, "bore-voice", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [channelCount],
    processorOptions: {
      coefficients: left.coefficients,
      periodSamples: left.periodSamples,
      rightCoefficients: right?.coefficients,
      rightPeriodSamples: right?.periodSamples,
      width: right ? parameters.width : 0,
      excited: !reliefIsFlat(profiles.left),
      rightExcited: !reliefIsFlat(right ? profiles.right : profiles.left),
      seed: (midiNote * 2_654_435_761) >>> 0,
    },
  });
  node.parameters.get("blow").value = parameters.blow;
  node.parameters.get("decay").value = parameters.decay;
  node.parameters.get("tone").value = parameters.tone;

  const envelope = context.createGain();
  envelope.gain.setValueAtTime(0, 0);
  envelope.gain.linearRampToValueAtTime(VOICE_PEAK, attackSeconds);
  envelope.gain.setValueAtTime(VOICE_PEAK, EXPORT_SUSTAIN_SECONDS);
  envelope.gain.linearRampToValueAtTime(0, EXPORT_SUSTAIN_SECONDS + releaseSeconds);
  node.connect(envelope).connect(master);

  const buffer = await context.startRendering();
  return Array.from({ length: channelCount }, (unused, channel) => buffer.getChannelData(channel));
}
