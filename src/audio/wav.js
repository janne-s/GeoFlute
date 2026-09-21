export const WAVETABLE_FRAME_SAMPLES = 2_048;

function writeText(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function clmComment(cycleSamples) {
  const comment = `<!>${cycleSamples} 00000000 GeoFlute`;
  return comment.length % 2 === 0 ? comment : `${comment} `;
}

/**
 * Mono 16-bit PCM. `declareCycle` adds the `clm ` chunk that Serum and Vital
 * read to learn the cycle length; Ableton rejects the file when it carries a
 * header it does not recognize, so a 1024-frame table is written without one.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {{ cycleSamples?: number, declareCycle?: boolean }} [options]
 */
export function encodeWavetableWav(samples, sampleRate, options = {}) {
  const cycleSamples = options.cycleSamples ?? WAVETABLE_FRAME_SAMPLES;
  const declareCycle = options.declareCycle ?? true;
  const comment = declareCycle ? clmComment(cycleSamples) : "";
  const dataLength = samples.length * 2;
  const clmLength = declareCycle ? 8 + comment.length : 0;
  const buffer = new ArrayBuffer(44 + clmLength + dataLength);
  const view = new DataView(buffer);

  writeText(view, 0, "RIFF");
  view.setUint32(4, 36 + clmLength + dataLength, true);
  writeText(view, 8, "WAVE");
  writeText(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  if (declareCycle) {
    writeText(view, 36, "clm ");
    view.setUint32(40, comment.length, true);
    writeText(view, 44, comment);
  }

  const dataOffset = 44 + clmLength;
  writeText(view, dataOffset - 8, "data");
  view.setUint32(dataOffset - 4, dataLength, true);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(dataOffset + index * 2, Math.round(clamped * 32_767), true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * @param {number} sampleCount
 * @param {{ cycleSamples?: number, declareCycle?: boolean }} [options]
 */
export function wavetableWavByteLength(sampleCount, options = {}) {
  const declareCycle = options.declareCycle ?? true;
  const comment = declareCycle ? clmComment(options.cycleSamples ?? WAVETABLE_FRAME_SAMPLES) : "";
  return 44 + (declareCycle ? 8 + comment.length : 0) + sampleCount * 2;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
