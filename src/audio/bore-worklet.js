import {
  AGC_OUTPUT_GAIN,
  AutoLeveler,
  BoreLadder,
  BreathNoise,
  BORE_DEFAULTS,
  endReflectionFromDecay,
  jetFromBlow,
  stereoNoiseMix,
  wallDecibelsFromDecay,
  wallTiltDecibelsFromTone,
} from "../model/bore.js?v=0.4.1";

const LEFT_BREATH_SALT = 0x5bf0_3635;
const RIGHT_BREATH_SALT = 0x27d4_eb2f;

class BoreVoiceProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "blow", defaultValue: BORE_DEFAULTS.blow, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "decay", defaultValue: BORE_DEFAULTS.decay, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "tone", defaultValue: BORE_DEFAULTS.tone, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  constructor(options) {
    super();
    const settings = options?.processorOptions ?? {};
    const seed = settings.seed ?? 0x9e37_79b9;
    this.leftLadder = new BoreLadder();
    this.rightLadder = new BoreLadder();
    this.sharedBreath = new BreathNoise(seed);
    this.leftBreath = new BreathNoise((seed ^ LEFT_BREATH_SALT) >>> 0);
    this.rightBreath = new BreathNoise((seed ^ RIGHT_BREATH_SALT) >>> 0);
    this.leveler = new AutoLeveler(sampleRate);
    this.running = true;
    this.excited = settings.excited ?? true;
    this.rightExcited = settings.rightExcited ?? this.excited;
    this.stereo = false;
    this.breathMix = stereoNoiseMix(0);
    const endReflection = endReflectionFromDecay(BORE_DEFAULTS.decay);
    const wallDecibels = wallDecibelsFromDecay(BORE_DEFAULTS.decay);
    const wallTilt = wallTiltDecibelsFromTone(BORE_DEFAULTS.tone);
    this.leftLadder.setLoop(endReflection, wallDecibels, wallTilt);
    this.rightLadder.setLoop(endReflection, wallDecibels, wallTilt);
    if (settings.coefficients) this.applyBore(settings);
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === "bore") {
        this.applyBore(message);
      } else if (message.type === "excitation") {
        this.excited = message.active;
        this.rightExcited = message.rightActive ?? message.active;
      } else if (message.type === "stop") {
        this.running = false;
      }
    };
  }

  applyBore(message) {
    this.leftLadder.setBore(message.coefficients, message.periodSamples);
    this.stereo = Boolean(message.rightCoefficients);
    this.breathMix = stereoNoiseMix(this.stereo ? message.width ?? 0 : 0);
    if (this.stereo) {
      this.rightLadder.setBore(
        message.rightCoefficients,
        message.rightPeriodSamples ?? message.periodSamples,
      );
    }
  }

  process(inputs, outputs, parameters) {
    const left = outputs[0][0];
    if (!left) return this.running;
    const right = outputs[0][1];
    const jet = jetFromBlow(parameters.blow[0]);
    const endReflection = endReflectionFromDecay(parameters.decay[0]);
    const wallDecibels = wallDecibelsFromDecay(parameters.decay[0]);
    const wallTilt = wallTiltDecibelsFromTone(parameters.tone[0]);
    this.leftLadder.setLoop(endReflection, wallDecibels, wallTilt);
    if (this.stereo) this.rightLadder.setLoop(endReflection, wallDecibels, wallTilt);

    for (let index = 0; index < left.length; index += 1) {
      if (!this.stereo) {
        const excitation = this.excited ? this.sharedBreath.next() * jet : 0;
        const pressure = this.leftLadder.process(excitation);
        const sample = AGC_OUTPUT_GAIN * Math.tanh(pressure * this.leveler.advance(pressure));
        left[index] = sample;
        if (right) right[index] = sample;
        continue;
      }
      const shared = this.sharedBreath.next();
      const leftExcitation = this.excited
        ? (shared * this.breathMix.shared + this.leftBreath.next() * this.breathMix.own) * jet
        : 0;
      const rightExcitation = this.rightExcited
        ? (shared * this.breathMix.shared + this.rightBreath.next() * this.breathMix.own) * jet
        : 0;
      const leftPressure = this.leftLadder.process(leftExcitation);
      const rightPressure = this.rightLadder.process(rightExcitation);
      const gain = this.leveler.advance((leftPressure + rightPressure) * 0.5);
      left[index] = AGC_OUTPUT_GAIN * Math.tanh(leftPressure * gain);
      if (right) right[index] = AGC_OUTPUT_GAIN * Math.tanh(rightPressure * gain);
    }
    return this.running;
  }
}

registerProcessor("bore-voice", BoreVoiceProcessor);
