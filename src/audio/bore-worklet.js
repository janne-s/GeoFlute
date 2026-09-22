import {
  AutoLeveler,
  BoreLadder,
  BreathNoise,
  BORE_DEFAULTS,
  endReflectionFromDecay,
  jetFromBlow,
  radiationFromTone,
} from "../model/bore.js?v=0.3.0";

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
    this.ladder = new BoreLadder();
    this.noise = new BreathNoise(settings.seed ?? 0x9e3779b9);
    this.leveler = new AutoLeveler(sampleRate);
    this.running = true;
    this.excited = settings.excited ?? true;
    this.ladder.setLoop(
      endReflectionFromDecay(BORE_DEFAULTS.decay),
      radiationFromTone(BORE_DEFAULTS.tone),
    );
    if (settings.coefficients) {
      this.ladder.setBore(settings.coefficients, settings.periodSamples);
    }
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === "bore") {
        this.ladder.setBore(message.coefficients, message.periodSamples);
      } else if (message.type === "excitation") {
        this.excited = message.active;
      } else if (message.type === "stop") {
        this.running = false;
      }
    };
  }

  process(inputs, outputs, parameters) {
    const channel = outputs[0][0];
    if (!channel) return this.running;
    const jet = this.excited ? jetFromBlow(parameters.blow[0]) : 0;
    this.ladder.setLoop(
      endReflectionFromDecay(parameters.decay[0]),
      radiationFromTone(parameters.tone[0]),
    );
    for (let index = 0; index < channel.length; index += 1) {
      const excitation = this.excited ? this.noise.next() * jet : 0;
      channel[index] = this.leveler.process(this.ladder.process(excitation));
    }
    return this.running;
  }
}

registerProcessor("bore-voice", BoreVoiceProcessor);
