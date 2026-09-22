export const MULTISAMPLE_STEP_SEMITONES = 3;
export const MULTISAMPLE_RANGE_SEMITONES = 24;
export const MULTISAMPLE_MINIMUM_KEY = 0;
export const MULTISAMPLE_MAXIMUM_KEY = 127;

export function multisampleNoteList(centerMidiNote, options = {}) {
  const step = options.stepSemitones ?? MULTISAMPLE_STEP_SEMITONES;
  const range = options.rangeSemitones ?? MULTISAMPLE_RANGE_SEMITONES;
  const notes = [];
  for (let offset = -range; offset <= range; offset += step) {
    notes.push(centerMidiNote + offset);
  }
  return notes;
}

export function multisampleKeyRanges(notes) {
  return notes.map((midiNote, index) => {
    const previous = notes[index - 1];
    const next = notes[index + 1];
    const lowKey = previous === undefined ? MULTISAMPLE_MINIMUM_KEY : Math.round((previous + midiNote) / 2) + 1;
    const highKey = next === undefined ? MULTISAMPLE_MAXIMUM_KEY : Math.round((midiNote + next) / 2);
    return { midiNote, lowKey, highKey };
  });
}

export function sfzDocument(options) {
  const { fileNames, keyRanges, releaseSeconds } = options;
  const lines = ["<group>", `ampeg_release=${releaseSeconds.toFixed(3)}`, ""];
  keyRanges.forEach((range, index) => {
    lines.push(
      "<region>",
      `sample=${fileNames[index]}`,
      `pitch_keycenter=${range.midiNote}`,
      `lokey=${range.lowKey}`,
      `hikey=${range.highKey}`,
      "",
    );
  });
  return lines.join("\n");
}
