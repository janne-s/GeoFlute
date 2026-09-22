import { midiNoteFrequency } from "../model/wavetable.js?v=0.3.0";
import {
  BORE_DEFAULTS,
  TEMPER_RECOMPUTE_THROTTLE_MS,
  boreFromProfile,
  boreSections,
  boreTuningOffsetSemitones,
  radiationFromTone,
  reliefIsFlat,
} from "../model/bore.js?v=0.3.0";

const WORKLET_URL = new URL("./bore-worklet.js?v=0.3.0", import.meta.url);
const VOICE_PEAK = 0.85;

export class BoreInstrument {
  constructor() {
    this.context = null;
    this.master = null;
    this.moduleReady = null;
    this.elevationMeters = null;
    this.isFlat = true;
    this.parameters = { ...BORE_DEFAULTS, temper: false };
    this.temperOffsetSemitones = 0;
    this.temperTimer = 0;
    this.voices = new Map();
  }

  setRelief(elevationMeters) {
    const wasFlat = this.isFlat;
    this.elevationMeters = elevationMeters;
    this.isFlat = reliefIsFlat(elevationMeters);
    for (const voice of this.voices.values()) {
      if (this.isFlat !== wasFlat) voice.node.port.postMessage({ type: "excitation", active: !this.isFlat });
      if (!this.isFlat) this.sendBore(voice);
    }
    this.scheduleTemperRecompute();
  }

  setParameters(parameters) {
    const previousDepth = this.parameters.depth;
    const previousTone = this.parameters.tone;
    const previousDecay = this.parameters.decay;
    const previousTemper = this.parameters.temper;
    this.parameters = { ...this.parameters, ...parameters };
    for (const voice of this.voices.values()) {
      voice.node.parameters.get("blow").value = this.parameters.blow;
      voice.node.parameters.get("decay").value = this.parameters.decay;
      voice.node.parameters.get("tone").value = this.parameters.tone;
      if (this.parameters.depth !== previousDepth || this.parameters.tone !== previousTone) {
        this.sendBore(voice);
      }
    }
    if (
      this.parameters.depth !== previousDepth
      || this.parameters.tone !== previousTone
      || this.parameters.decay !== previousDecay
      || (this.parameters.temper && !previousTemper)
    ) {
      this.scheduleTemperRecompute();
    }
  }

  scheduleTemperRecompute() {
    if (!this.parameters.temper || !this.elevationMeters || this.isFlat || this.temperTimer) return;
    this.temperTimer = setTimeout(() => {
      this.temperTimer = 0;
      if (!this.parameters.temper || !this.elevationMeters || this.isFlat) return;
      this.temperOffsetSemitones = boreTuningOffsetSemitones(this.elevationMeters, {
        sampleRate: this.context?.sampleRate ?? 44_100,
        depth: this.parameters.depth,
        tone: this.parameters.tone,
        decay: this.parameters.decay,
      });
      for (const voice of this.voices.values()) this.sendBore(voice);
    }, TEMPER_RECOMPUTE_THROTTLE_MS);
  }

  boreForNote(midiNote) {
    const sampleRate = this.context?.sampleRate ?? 44_100;
    const periodSamples = sampleRate / midiNoteFrequency(midiNote);
    const sections = boreSections(periodSamples, radiationFromTone(this.parameters.tone));
    const bore = boreFromProfile(this.elevationMeters, { sections, depth: this.parameters.depth });
    const tunedPeriodSamples = this.parameters.temper
      ? periodSamples * 2 ** (this.temperOffsetSemitones / 12)
      : periodSamples;
    return { coefficients: bore.coefficients, periodSamples: tunedPeriodSamples };
  }

  sendBore(voice) {
    if (!this.elevationMeters) return;
    const bore = this.boreForNote(voice.midiNote);
    voice.node.port.postMessage({
      type: "bore",
      coefficients: bore.coefficients,
      periodSamples: bore.periodSamples,
    });
  }

  async ensureContext() {
    if (!("AudioContext" in globalThis)) {
      throw new Error("Web Audio is not available in this browser");
    }
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: "interactive" });
      this.master = this.context.createGain();
      const highPass = this.context.createBiquadFilter();
      const limiter = this.context.createDynamicsCompressor();
      highPass.type = "highpass";
      highPass.frequency.value = 18;
      limiter.threshold.value = -7;
      limiter.knee.value = 3;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.12;
      this.master.gain.value = 0.55;
      this.master.connect(highPass).connect(limiter).connect(this.context.destination);
    }
    if (!this.moduleReady) {
      this.moduleReady = this.context.audioWorklet.addModule(WORKLET_URL);
    }
    await this.moduleReady;
    await this.context.resume();
  }

  async noteOn(key, midiNote, envelope = {}) {
    if (!this.elevationMeters) return false;
    await this.ensureContext();
    this.noteOff(key, 0.01);
    const bore = this.boreForNote(midiNote);
    const now = this.context.currentTime;
    const attackSeconds = Math.max(0.003, envelope.attackSeconds ?? 0.02);
    const node = new AudioWorkletNode(this.context, "bore-voice", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        coefficients: bore.coefficients,
        periodSamples: bore.periodSamples,
        excited: !this.isFlat,
        seed: (midiNote * 2_654_435_761) >>> 0,
      },
    });
    node.parameters.get("blow").value = this.parameters.blow;
    node.parameters.get("decay").value = this.parameters.decay;
    node.parameters.get("tone").value = this.parameters.tone;
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(VOICE_PEAK, now + attackSeconds);
    node.connect(gain).connect(this.master);
    this.voices.set(key, { node, gain, midiNote });
    return true;
  }

  transpose(semitones) {
    if (!this.context || semitones === 0) return;
    for (const voice of this.voices.values()) {
      voice.midiNote += semitones;
      this.sendBore(voice);
    }
  }

  noteOff(key, releaseSeconds = 0.25) {
    const voice = this.voices.get(key);
    if (!voice || !this.context) return;
    this.voices.delete(key);
    const now = this.context.currentTime;
    const release = Math.max(0.01, releaseSeconds);
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + release);
    setTimeout(() => {
      voice.node.port.postMessage({ type: "stop" });
      voice.node.disconnect();
      voice.gain.disconnect();
    }, (release + 0.05) * 1_000);
  }

  stopAll(releaseSeconds = 0.03) {
    for (const key of [...this.voices.keys()]) this.noteOff(key, releaseSeconds);
  }
}
