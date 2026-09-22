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

function encodePcmWav(channels, sampleRate, options = {}) {
  const channelCount = channels.length;
  const frameCount = channels[0].length;
  const comment = options.comment ?? "";
  const blockAlign = channelCount * 2;
  const dataLength = frameCount * blockAlign;
  const clmLength = comment ? 8 + comment.length : 0;
  const buffer = new ArrayBuffer(44 + clmLength + dataLength);
  const view = new DataView(buffer);

  writeText(view, 0, "RIFF");
  view.setUint32(4, 36 + clmLength + dataLength, true);
  writeText(view, 8, "WAVE");
  writeText(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  if (comment) {
    writeText(view, 36, "clm ");
    view.setUint32(40, comment.length, true);
    writeText(view, 44, comment);
  }

  const dataOffset = 44 + clmLength;
  writeText(view, dataOffset - 8, "data");
  view.setUint32(dataOffset - 4, dataLength, true);
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const clamped = Math.max(-1, Math.min(1, channels[channel][frame]));
      view.setInt16(
        dataOffset + (frame * channelCount + channel) * 2,
        Math.round(clamped * 32_767),
        true,
      );
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Mono 16-bit PCM. `declareCycle` adds the `clm ` chunk that Serum and Vital
 * read to learn the cycle length; Ableton rejects the file when it carries a
 * header it does not recognize, so a 1024-frame table is written without one.
 * A wavetable bank is mono by the format's own contract and stays that way.
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {{ cycleSamples?: number, declareCycle?: boolean }} [options]
 */
export function encodeWavetableWav(samples, sampleRate, options = {}) {
  const declareCycle = options.declareCycle ?? true;
  return encodePcmWav([samples], sampleRate, {
    comment: declareCycle ? clmComment(options.cycleSamples ?? WAVETABLE_FRAME_SAMPLES) : "",
  });
}

/**
 * Interleaved 16-bit PCM for rendered notes, where a stereo pair is one pair of
 * transects rather than a widened mono signal.
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 */
export function encodeNoteWav(channels, sampleRate) {
  return encodePcmWav(channels, sampleRate);
}

/**
 * @param {number} sampleCount
 * @param {{ cycleSamples?: number, declareCycle?: boolean, channels?: number }} [options]
 */
export function wavetableWavByteLength(sampleCount, options = {}) {
  const declareCycle = options.declareCycle ?? true;
  const comment = declareCycle ? clmComment(options.cycleSamples ?? WAVETABLE_FRAME_SAMPLES) : "";
  const channels = Math.max(1, Math.round(options.channels ?? 1));
  return 44 + (declareCycle ? 8 + comment.length : 0) + sampleCount * channels * 2;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
