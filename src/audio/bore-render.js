import { midiNoteFrequency } from "../model/wavetable.js?v=0.3.0";
import { boreFromProfile, boreSections, boreTuningOffsetSemitones, radiationFromTone } from "../model/bore.js?v=0.3.0";

const WORKLET_URL = new URL("./bore-worklet.js?v=0.3.0", import.meta.url);
const VOICE_PEAK = 0.85;
export const EXPORT_SUSTAIN_SECONDS = 2;
export const EXPORT_TAIL_SECONDS = 1;

export async function renderBoreMultisample(elevationMeters, midiNotes, parameters, options = {}) {
  const sampleRate = options.sampleRate ?? 44_100;
  const attackSeconds = options.attackSeconds ?? 0.02;
  const releaseSeconds = options.releaseSeconds ?? 0.3;
  const temperOffsetSemitones = parameters.temper
    ? boreTuningOffsetSemitones(elevationMeters, {
      sampleRate,
      depth: parameters.depth,
      tone: parameters.tone,
      decay: parameters.decay,
    })
    : 0;
  const renders = [];
  for (const midiNote of midiNotes) {
    renders.push({
      midiNote,
      samples: await renderNote(elevationMeters, midiNote, parameters, temperOffsetSemitones, {
        sampleRate,
        attackSeconds,
        releaseSeconds,
      }),
    });
  }
  return renders;
}

async function renderNote(elevationMeters, midiNote, parameters, temperOffsetSemitones, options) {
  const { sampleRate, attackSeconds, releaseSeconds } = options;
  const totalSeconds = EXPORT_SUSTAIN_SECONDS + releaseSeconds + EXPORT_TAIL_SECONDS;
  const context = new OfflineAudioContext(1, Math.ceil(totalSeconds * sampleRate), sampleRate);
  await context.audioWorklet.addModule(WORKLET_URL);

  const naivePeriodSamples = sampleRate / midiNoteFrequency(midiNote);
  const sections = boreSections(naivePeriodSamples, radiationFromTone(parameters.tone));
  const bore = boreFromProfile(elevationMeters, { sections, depth: parameters.depth });
  const periodSamples = temperOffsetSemitones
    ? naivePeriodSamples * 2 ** (temperOffsetSemitones / 12)
    : naivePeriodSamples;

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
    outputChannelCount: [1],
    processorOptions: {
      coefficients: bore.coefficients,
      periodSamples,
      excited: true,
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
  return buffer.getChannelData(0);
}
