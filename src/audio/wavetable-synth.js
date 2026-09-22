import { midiNoteFrequency } from "../model/wavetable.js?v=0.4.0";

const OCTAVE_GLIDE_SECONDS = 0.02;

export class WavetableInstrument {
  constructor() {
    this.context = null;
    this.master = null;
    this.periodicWave = null;
    this.wavetable = null;
    this.voices = new Map();
  }

  setWavetable(wavetable) {
    this.wavetable = wavetable;
    this.periodicWave = this.context ? this.createPeriodicWave() : null;
    if (this.periodicWave) {
      for (const voice of this.voices.values()) voice.oscillator.setPeriodicWave(this.periodicWave);
    }
  }

  createPeriodicWave() {
    if (!this.context || !this.wavetable) return null;
    return this.context.createPeriodicWave(
      this.wavetable.real,
      this.wavetable.imaginary,
      { disableNormalization: true },
    );
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
      this.periodicWave = this.createPeriodicWave();
    }
    await this.context.resume();
  }

  async noteOn(key, midiNote, envelope = {}) {
    if (!this.wavetable || this.wavetable.isFlat) return false;
    await this.ensureContext();
    this.noteOff(key, 0.01);
    const now = this.context.currentTime;
    const attackSeconds = Math.max(0.003, envelope.attackSeconds ?? 0.02);
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.setPeriodicWave(this.periodicWave);
    oscillator.frequency.setValueAtTime(midiNoteFrequency(midiNote), now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.72, now + attackSeconds);
    oscillator.connect(gain).connect(this.master);
    oscillator.start(now);
    this.voices.set(key, { oscillator, gain, midiNote });
    return true;
  }

  transpose(semitones) {
    if (!this.context || semitones === 0) return;
    const now = this.context.currentTime;
    for (const voice of this.voices.values()) {
      voice.midiNote += semitones;
      voice.oscillator.frequency.cancelScheduledValues(now);
      voice.oscillator.frequency.setValueAtTime(voice.oscillator.frequency.value, now);
      voice.oscillator.frequency.exponentialRampToValueAtTime(
        midiNoteFrequency(voice.midiNote),
        now + OCTAVE_GLIDE_SECONDS,
      );
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
    voice.oscillator.stop(now + release + 0.02);
    voice.oscillator.addEventListener("ended", () => {
      voice.oscillator.disconnect();
      voice.gain.disconnect();
    }, { once: true });
  }

  stopAll(releaseSeconds = 0.03) {
    for (const key of [...this.voices.keys()]) this.noteOff(key, releaseSeconds);
  }
}
