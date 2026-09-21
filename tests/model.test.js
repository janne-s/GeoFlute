import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { encodeWavetableWav, wavetableWavByteLength, WAVETABLE_FRAME_SAMPLES } from "../src/audio/wav.js?v=0.3.0";
import { zipStore } from "../src/audio/zip.js?v=0.3.0";
import { WavetableInstrument } from "../src/audio/wavetable-synth.js?v=0.3.0";
import { APPLICATION_VERSION, createPatch, createReliefProfile, parsePatch } from "../src/model/patch.js?v=0.3.0";
import { createMulberry32 } from "../src/model/prng.js?v=0.3.0";
import { createFlatTerrain, createFoundationTerrain, createSinusoidalRidge } from "../src/model/terrain.js?v=0.3.0";
import {
  buildTerrainWavetable,
  buildWavetableFrames,
  midiNoteFrequency,
  renderWavetableNote,
  resampleProfile,
  WAVETABLE_LENGTH,
} from "../src/model/wavetable.js?v=0.3.0";

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

describe("sounding voices", () => {
  function stubVoice(instrument, key, midiNote) {
    const ramps = [];
    instrument.voices.set(key, {
      midiNote,
      gain: {},
      oscillator: {
        frequency: {
          value: midiNoteFrequency(midiNote),
          cancelScheduledValues() {},
          setValueAtTime() {},
          exponentialRampToValueAtTime(target) {
            ramps.push(target);
          },
        },
      },
    });
    return ramps;
  }

  it("retunes every sounding voice when the octave moves", () => {
    const instrument = new WavetableInstrument();
    instrument.context = { currentTime: 0 };
    const hold = stubVoice(instrument, "hold", 60);
    const key = stubVoice(instrument, "key:KeyA", 64);

    instrument.transpose(12);

    assert.equal(instrument.voices.get("hold").midiNote, 72);
    assert.equal(instrument.voices.get("key:KeyA").midiNote, 76);
    assert.deepEqual(hold, [midiNoteFrequency(72)]);
    assert.deepEqual(key, [midiNoteFrequency(76)]);
  });

  it("leaves voices alone when the octave does not move", () => {
    const instrument = new WavetableInstrument();
    instrument.context = { currentTime: 0 };
    const hold = stubVoice(instrument, "hold", 60);

    instrument.transpose(0);

    assert.equal(instrument.voices.get("hold").midiNote, 60);
    assert.deepEqual(hold, []);
  });
});

describe("browser session", () => {
  it("restores every control it stored", () => {
    const state = {
      selection: { west: -61.75, south: 15.96, east: -61.56, north: 16.16 },
      widthMeters: 20_325,
      heightMeters: 22_264,
      provider: "mapzen-terrain-tiles-aws",
      resolutionMeters: 36.7,
      gridSize: 256,
      elevationRangeMeters: [-18, 1_457],
      view: { longitude: -61.45, latitude: 16.2, zoom: 9 },
      bearingDeg: 137,
      bankPosition: -0.42,
      harmonicLimit: 96,
      seamMethod: "direct-profile",
      normalized: false,
      cycleSamples: WAVETABLE_FRAME_SAMPLES,
      octaveOffset: -2,
      attackSeconds: 0.05,
      releaseSeconds: 0.9,
      scanRateHz: 0.65,
      scanDepth: 0.4,
      scanSmooth: 0.8,
      seed: 0x47554c46,
    };
    const restored = parsePatch(JSON.stringify(createPatch(state)));

    assert.deepEqual(restored.selection, state.selection);
    assert.equal(restored.bearingDeg, state.bearingDeg);
    assert.equal(restored.bankPosition, state.bankPosition);
    assert.equal(restored.harmonicLimit, state.harmonicLimit);
    assert.equal(restored.seamMethod, state.seamMethod);
    assert.equal(restored.normalized, state.normalized);
    assert.equal(restored.octaveOffset, state.octaveOffset);
    assert.equal(restored.attackSeconds, state.attackSeconds);
    assert.equal(restored.releaseSeconds, state.releaseSeconds);
    assert.equal(restored.scanRateHz, state.scanRateHz);
    assert.equal(restored.scanDepth, state.scanDepth);
    assert.equal(restored.scanSmooth, state.scanSmooth);
    assert.equal(restored.view.zoom, state.view.zoom);
  });

  it("refuses stored content that is not a GeoFlute session", () => {
    assert.throws(() => parsePatch("<!doctype html>"), /not valid JSON/);
    assert.throws(() => parsePatch('{"format":"echotect-project"}'), /not a GeoFlute patch/);
  });
});

describe("export package", () => {
  it("predicts the encoded WAV length without rendering it", async () => {
    const samples = new Float32Array(4 * WAVETABLE_FRAME_SAMPLES);
    for (const options of [
      { cycleSamples: WAVETABLE_FRAME_SAMPLES },
      { cycleSamples: 1_024, declareCycle: false },
    ]) {
      const blob = encodeWavetableWav(samples, 44_100, options);
      assert.equal(wavetableWavByteLength(samples.length, options), blob.size);
    }
  });

  it("writes a store-only archive that repeats byte for byte", () => {
    const files = [
      { name: "a.wav", data: new Uint8Array([1, 2, 3, 4]) },
      { name: "b.json", data: new TextEncoder().encode("{}\n") },
    ];
    const archive = zipStore(files);
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    assert.equal(view.getUint32(0, true), 0x04034b50);
    assert.equal(view.getUint32(archive.length - 22, true), 0x06054b50);
    assert.equal(view.getUint16(archive.length - 12, true), files.length);
    assert.deepEqual(zipStore(files), archive);
  });

  it("keeps the single-frame bank on the selected transect", () => {
    const terrain = createFoundationTerrain();
    const centre = buildWavetableFrames(terrain, { bearingDeg: 90, position: 0 }, { frames: 1 });
    const offset = buildWavetableFrames(terrain, { bearingDeg: 90, position: 0.8 }, { frames: 1 });
    assert.equal(centre.length, WAVETABLE_LENGTH);
    assert.notDeepEqual(Array.from(offset), Array.from(centre));
  });

  it("resamples a transect profile without moving its endpoints", () => {
    const source = Float32Array.from({ length: 2_048 }, (_, index) => index);
    const resampled = resampleProfile(source, 64);
    assert.equal(resampled.length, 64);
    assert.equal(resampled[0], source[0]);
    assert.equal(resampled[63], source[2_047]);
  });

  it("carries the relief itself, not only the bounds that produced it", () => {
    const terrain = createFoundationTerrain();
    const wavetable = buildTerrainWavetable(terrain, { bearingDeg: 45, seamMethod: "direct-profile" });
    const document = createReliefProfile({
      selection: { west: -1, south: -1, east: 1, north: 1 },
      widthMeters: terrain.widthMeters,
      heightMeters: terrain.heightMeters,
      provider: "test",
      resolutionMeters: 30,
      gridSize: terrain.size,
      bearingDeg: wavetable.transect.bearingDeg,
      bankPosition: wavetable.transect.position,
      lengthMeters: wavetable.transect.lengthMeters,
      elevationMeters: resampleProfile(wavetable.elevationMeters, 64),
      seed: 1,
    });

    assert.equal(document.format, "geoflute-relief");
    assert.equal(document.transect.sections, 64);
    assert.equal(document.elevationMeters.length, 64);
    assert.equal(document.provenance, "SIMULATED");
    assert.ok(document.elevationRangeMeters[1] > document.elevationRangeMeters[0]);
    assert.ok(document.elevationMeters.every(Number.isFinite));
  });

  it("keeps a flat transect flat in the relief document", () => {
    const terrain = createFlatTerrain();
    const wavetable = buildTerrainWavetable(terrain, { seamMethod: "direct-profile" });
    const profile = resampleProfile(wavetable.elevationMeters, 64);
    const range = Math.max(...profile) - Math.min(...profile);
    assert.ok(range < 1e-6);
  });
});

describe("release version", () => {
  const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version;

  function sourceFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.name.endsWith(".js") ? [path] : [];
    });
  }

  it("stamps the package version on every relative import", () => {
    const pattern = /from "(\.\.?\/[^"]+)"/g;
    const stale = [];
    const roots = ["../src", "../tests"].map((directory) => fileURLToPath(new URL(directory, import.meta.url)));
    for (const path of roots.flatMap(sourceFiles)) {
      for (const [, specifier] of readFileSync(path, "utf8").matchAll(pattern)) {
        if (specifier !== `${specifier.split("?")[0]}?v=${packageVersion}`) stale.push(`${path}: ${specifier}`);
      }
    }
    assert.deepEqual(stale, [], `unversioned or stale imports:\n${stale.join("\n")}`);
  });

  it("stamps the package version on the entry URLs", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    assert.match(html, new RegExp(`src="\\./src/main\\.js\\?v=${packageVersion}"`));
    assert.match(html, new RegExp(`href="\\./src/style\\.css\\?v=${packageVersion}"`));
  });

  it("reports the package version in exported documents", () => {
    assert.equal(APPLICATION_VERSION, packageVersion);
  });
});
