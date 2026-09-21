import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeWavetableWav, WAVETABLE_FRAME_SAMPLES } from "../src/audio/wav.js";
import { createPatch, parsePatch } from "../src/model/patch.js";
import { createMulberry32 } from "../src/model/prng.js";
import { createFlatTerrain, createFoundationTerrain, createSinusoidalRidge } from "../src/model/terrain.js";
import {
  buildTerrainWavetable,
  buildWavetableFrames,
  midiNoteFrequency,
  renderWavetableNote,
  WAVETABLE_LENGTH,
} from "../src/model/wavetable.js";

describe("deterministic model foundation", () => {
  it("repeats the same pseudo-random sequence for an identical seed", () => {
    const first = createMulberry32(42);
    const second = createMulberry32(42);
    assert.deepEqual(
      Array.from({ length: 8 }, () => first.next()),
      Array.from({ length: 8 }, () => second.next()),
    );
  });

  it("turns a terrain transect into a bounded seamless wavetable", () => {
    const terrain = createSinusoidalRidge(32, 16_000, 4);
    const wavetable = buildTerrainWavetable(terrain, {
      bearingDeg: 90,
      position: 0,
      harmonicLimit: 32,
    });
    assert.equal(wavetable.waveform.length, WAVETABLE_LENGTH);
    assert.equal(wavetable.real.length, 33);
    assert.equal(wavetable.imaginary.length, 33);
    assert.equal(wavetable.maximumHarmonic, 32);
    assert.equal(wavetable.isFlat, false);
    assert.ok(wavetable.transect.lengthMeters > 15_900);
    assert.ok(Math.max(...wavetable.waveform.map(Math.abs)) <= 0.921);
    assert.ok(Math.abs(wavetable.waveform[0] - wavetable.waveform.at(-1)) < 0.02);
  });

  it("plays the transect once, seam-safe, in direct-profile mode", () => {
    const terrain = createSinusoidalRidge(32, 16_000, 4);
    const parameters = { bearingDeg: 90, position: 0, harmonicLimit: 32 };
    const mirrored = buildTerrainWavetable(terrain, parameters);
    const direct = buildTerrainWavetable(terrain, {
      ...parameters,
      seamMethod: "direct-profile",
    });

    assert.equal(direct.seamMethod, "direct-profile");
    assert.equal(direct.waveform.length, WAVETABLE_LENGTH);
    assert.ok(Math.max(...direct.waveform.map(Math.abs)) <= 0.921);
    assert.ok(Math.abs(direct.waveform[0] - direct.waveform.at(-1)) < 0.02);
    const strongest = (wavetable) => wavetable.real
      .reduce((best, _value, harmonic) => (
        Math.hypot(wavetable.real[harmonic], wavetable.imaginary[harmonic])
          > Math.hypot(wavetable.real[best], wavetable.imaginary[best]) ? harmonic : best
      ), 1);
    assert.equal(strongest(direct), 4);
    assert.ok(strongest(mirrored) > strongest(direct));
  });

  it("scales amplitude with relief when normalization is off", () => {
    const parameters = { bearingDeg: 90, position: 0, harmonicLimit: 32, normalize: false };
    const low = buildTerrainWavetable(createSinusoidalRidge(32, 16_000, 4, 50), parameters);
    const high = buildTerrainWavetable(createSinusoidalRidge(32, 16_000, 4, 500), parameters);
    const peak = (wavetable) => Math.max(...wavetable.waveform.map(Math.abs));

    assert.ok(peak(high) > peak(low) * 9);
    assert.ok(peak(high) <= 0.921);
    const normalized = buildTerrainWavetable(
      createSinusoidalRidge(32, 16_000, 4, 50),
      { ...parameters, normalize: true },
    );
    assert.ok(peak(normalized) > peak(low) * 9);
  });

  it("stops normalization from amplifying near-flat relief to full scale", () => {
    const parameters = { bearingDeg: 90, position: 0, harmonicLimit: 32, normalize: true };
    const peak = (wavetable) => Math.max(...wavetable.waveform.map(Math.abs));
    const barelyThere = buildTerrainWavetable(createSinusoidalRidge(32, 16_000, 4, 0.5), parameters);
    const realRelief = buildTerrainWavetable(createSinusoidalRidge(32, 16_000, 4, 400), parameters);

    assert.ok(peak(barelyThere) < 0.1);
    assert.ok(peak(realRelief) > 0.9);
  });

  it("keeps a flat terrain wavetable silent", () => {
    const wavetable = buildTerrainWavetable(createFlatTerrain(32, 20_000), {
      bearingDeg: 45,
      position: 0.5,
      harmonicLimit: 64,
    });
    assert.equal(wavetable.isFlat, true);
    assert.ok(wavetable.waveform.every((sample) => sample === 0));
  });

  it("renders deterministic pitched wavetable notes with an envelope", () => {
    const terrain = createSinusoidalRidge(32, 16_000, 4);
    const wavetable = buildTerrainWavetable(terrain, { harmonicLimit: 24 });
    const parameters = {
      sampleRate: 8_000,
      durationSeconds: 0.25,
      midiNote: 69,
      attackSeconds: 0.01,
      releaseSeconds: 0.05,
    };
    const first = renderWavetableNote(wavetable, parameters);
    const second = renderWavetableNote(wavetable, parameters);
    assert.deepEqual(first.samples, second.samples);
    assert.equal(first.samples.length, 2_000);
    assert.equal(first.frequencyHz, 440);
    assert.equal(midiNoteFrequency(60).toFixed(3), "261.626");
    assert.ok(Math.abs(first.samples[0]) < 1e-9);
    assert.ok(Math.abs(first.samples.at(-1)) < 1e-6);
  });

  it("exports a mono 16-bit wavetable WAV that declares its cycle length", async () => {
    const samples = new Float32Array([0, 0.25, -0.5, 1]);
    const blob = encodeWavetableWav(samples, 44_100, { cycleSamples: WAVETABLE_FRAME_SAMPLES });
    const buffer = await blob.arrayBuffer();
    const view = new DataView(buffer);
    const text = (offset, length) => String.fromCharCode(
      ...new Uint8Array(buffer, offset, length),
    );

    assert.equal(text(0, 4), "RIFF");
    assert.equal(view.getUint32(4, true), buffer.byteLength - 8);
    assert.equal(text(8, 4), "WAVE");
    assert.equal(view.getUint16(20, true), 1);
    assert.equal(view.getUint16(22, true), 1);
    assert.equal(view.getUint32(24, true), 44_100);
    assert.equal(view.getUint16(34, true), 16);

    assert.equal(text(36, 4), "clm ");
    const commentLength = view.getUint32(40, true);
    assert.equal(commentLength % 2, 0);
    assert.match(text(44, commentLength), /^<!>2048 00000000 /);

    const dataOffset = 44 + commentLength;
    assert.equal(text(dataOffset, 4), "data");
    assert.equal(view.getUint32(dataOffset + 4, true), samples.length * 2);
    assert.equal(view.getInt16(dataOffset + 8 + 2 * 2, true), Math.round(-0.5 * 32_767));
  });

  it("writes an Ableton-safe table without a serum header", async () => {
    const samples = new Float32Array([0, 0.25, -0.5, 1]);
    const blob = encodeWavetableWav(samples, 44_100, { cycleSamples: 1_024, declareCycle: false });
    const buffer = await blob.arrayBuffer();
    const view = new DataView(buffer);
    const text = (offset, length) => String.fromCharCode(
      ...new Uint8Array(buffer, offset, length),
    );

    assert.equal(text(36, 4), "data");
    assert.equal(view.getUint32(40, true), samples.length * 2);
    assert.equal(view.getUint32(4, true), buffer.byteLength - 8);
    assert.ok(!text(0, buffer.byteLength).includes("clm "));
  });

  it("decimates export frames to the requested cycle length", () => {
    const terrain = createSinusoidalRidge(32, 16_000, 4, 400);
    const parameters = { bearingDeg: 90, harmonicLimit: 32 };
    const wide = buildWavetableFrames(terrain, parameters, { frames: 4 });
    const narrow = buildWavetableFrames(terrain, parameters, {
      frames: 4,
      frameSamples: WAVETABLE_LENGTH / 2,
    });

    assert.equal(wide.length, 4 * WAVETABLE_LENGTH);
    assert.equal(narrow.length, 4 * (WAVETABLE_LENGTH / 2));
    assert.equal(narrow[0], wide[0]);
    assert.equal(narrow[1], wide[2]);
  });

  it("keeps relief differences between exported frames and still fills the file", () => {
    const terrain = createFoundationTerrain({ size: 128, widthMeters: 20_000, heightMeters: 20_000 });
    const parameters = { bearingDeg: 90, harmonicLimit: 64, normalize: false };
    const framePeaks = (samples, frames) => Array.from({ length: frames }, (_unused, frame) => {
      let peak = 0;
      for (let sample = 0; sample < WAVETABLE_LENGTH; sample += 1) {
        peak = Math.max(peak, Math.abs(samples[frame * WAVETABLE_LENGTH + sample]));
      }
      return peak;
    });

    const flat = framePeaks(
      buildWavetableFrames(terrain, { ...parameters, normalize: true }, { frames: 16 }),
      16,
    );
    const relief = framePeaks(buildWavetableFrames(terrain, parameters, { frames: 16, fitToPeak: true }), 16);

    assert.ok(Math.max(...flat) - Math.min(...flat) < 1e-6);
    assert.ok(Math.max(...relief) - Math.min(...relief) > 0.3);
    assert.ok(Math.max(...relief) > 0.9);
    assert.ok(Math.max(...relief) <= 0.921);
  });

  it("restores a patch through a save and load round trip", () => {
    const saved = createPatch({
      selection: { west: -61.75, south: 15.96, east: -61.56, north: 16.16 },
      view: { longitude: -61.45, latitude: 16.2, zoom: 9 },
      bearingDeg: 215,
      bankPosition: -0.42,
      harmonicLimit: 128,
      seamMethod: "direct-profile",
      normalized: false,
      octaveOffset: -2,
      attackSeconds: 0.05,
      releaseSeconds: 0.8,
      scanRateHz: 1.25,
      scanDepth: 0.4,
      scanSmooth: 0.6,
      seed: 42,
    });
    const loaded = parsePatch(JSON.stringify(saved));

    assert.deepEqual(loaded.selection, { west: -61.75, south: 15.96, east: -61.56, north: 16.16 });
    assert.equal(loaded.bearingDeg, 215);
    assert.equal(loaded.seamMethod, "direct-profile");
    assert.equal(loaded.normalized, false);
    assert.equal(loaded.octaveOffset, -2);
    assert.equal(loaded.scanSmooth, 0.6);
    assert.equal(loaded.view.zoom, 9);
  });

  it("refuses a foreign file and clamps out-of-range patch values", () => {
    assert.throws(() => parsePatch("not json"), /not valid JSON/);
    assert.throws(() => parsePatch('{"format":"something-else"}'), /not a GeoFlute patch/);
    assert.throws(
      () => parsePatch('{"format":"geoflute-patch","geometry":{"bounds":{"west":10}}}'),
      /no usable area bounds/,
    );

    const loaded = parsePatch(JSON.stringify({
      format: "geoflute-patch",
      geometry: { bounds: { west: -1, south: -1, east: 1, north: 1 } },
      cycle: { bearingDeg: 9_000, harmonicLimit: -5, seamMethod: "nonsense" },
      scan: { rateHz: "fast", depth: 12 },
    }));
    assert.equal(loaded.bearingDeg, 359);
    assert.equal(loaded.harmonicLimit, 8);
    assert.equal(loaded.seamMethod, "forward-reverse-mirror");
    assert.equal(loaded.scanRateHz, 0.2);
    assert.equal(loaded.scanDepth, 1);
  });
});
