import { downloadBlob, encodeNoteWav, encodeWavetableWav, wavetableWavByteLength, WAVETABLE_FRAME_SAMPLES } from "./audio/wav.js?v=0.4.0";
import { zipStore } from "./audio/zip.js?v=0.4.0";
import { WavetableInstrument } from "./audio/wavetable-synth.js?v=0.4.0";
import { BoreInstrument } from "./audio/bore-synth.js?v=0.4.0";
import { EXPORT_SUSTAIN_SECONDS, EXPORT_TAIL_SECONDS, renderBoreMultisample } from "./audio/bore-render.js?v=0.4.0";
import { findPlace } from "./data/place-search.js?v=0.4.0";
import { loadTerrainGrid } from "./data/terrain-tiles.js?v=0.4.0";
import { WorldMap } from "./map/world-map.js?v=0.4.0";
import { multisampleKeyRanges, multisampleNoteList, sfzDocument } from "./model/multisample.js?v=0.4.0";
import { analysisExtent, areaDimensions, createFoundationTerrain, FOUNDATION_SEED } from "./model/terrain.js?v=0.4.0";
import { stereoTransectPositions } from "./model/bore.js?v=0.4.0";
import { createPatch, createReliefProfile, parsePatch } from "./model/patch.js?v=0.4.0";
import {
  buildTerrainWavetable,
  buildWavetableFrames,
  midiNoteFrequency,
  midiNoteName,
  resampleProfile,
  terrainProfileBank,
  transectProfile,
  transectSeparationMeters,
} from "./model/wavetable.js?v=0.4.0";
import { drawTerrain, drawWavetable } from "./visual/canvas.js?v=0.4.0";

const DEFAULT_SELECTION = {
  west: -61.75,
  south: 15.96,
  east: -61.56,
  north: 16.16,
};
const DEFAULT_VIEW = { center: { longitude: -61.45, latitude: 16.2 }, zoom: 9 };
const ANALYSIS_GRID_SIZE = 256;
const AUDIO_SAMPLE_RATE = 44_100;
const MAX_BANK_POSITION = 1;
const SCAN_UPDATE_INTERVAL_MS = 16;
const MINIMUM_SCAN_GLIDE = 0.015;
const MINIMUM_HARMONICS = 2;
const MAXIMUM_HARMONICS = 256;
const EXPORT_FRAME_COUNT = 256;
const ABLETON_FRAME_SAMPLES = WAVETABLE_FRAME_SAMPLES / 2;
const RELIEF_SECTIONS = 64;
const SESSION_STORAGE_KEY = "geoflute-session";
const SESSION_SAVE_DELAY_MS = 500;
const KEYBOARD_NOTES = new Map([
  ["KeyA", 60], ["KeyW", 61], ["KeyS", 62], ["KeyE", 63],
  ["KeyD", 64], ["KeyF", 65], ["KeyT", 66], ["KeyG", 67],
  ["KeyY", 68], ["KeyH", 69], ["KeyU", 70], ["KeyJ", 71], ["KeyK", 72],
]);
const MAX_SELECTION_LATITUDE = 85;
const MIN_OCTAVE_OFFSET = -3;
const MAX_OCTAVE_OFFSET = 3;

const root = document.querySelector("#app");
if (!root) throw new Error("Application root is missing");

root.innerHTML = `
  <main class="shell">
    <section class="workspace">
      <figure class="panel map-panel">
        <div class="map-toolbar" aria-label="Map tools">
          <div class="tool-group">
            <span class="wordmark"><span class="prompt">&gt;</span> GEOFLUTE</span>
            <button class="tool" id="new-area" type="button" aria-pressed="false">NEW AREA</button>
            <a class="github-link" href="https://github.com/janne-s/GeoFlute" target="_blank" rel="noopener noreferrer" aria-label="GeoFlute on GitHub" title="GeoFlute on GitHub">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 .7a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2.2c-3.4.7-4.1-1.4-4.1-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.8 5.4-5.5 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .7Z"/>
              </svg>
            </a>
          </div>
          <div class="tool-group">
            <button class="tool is-active" type="button" data-base-layer="relief">RELIEF</button>
            <button class="tool" type="button" data-base-layer="map">MAP</button>
            <button class="tool" id="view-world" type="button">WORLD</button>
            <button class="tool square" id="zoom-out" type="button" aria-label="Zoom out">−</button>
            <button class="tool square" id="zoom-in" type="button" aria-label="Zoom in">+</button>
            <button class="tool square" id="info-toggle" type="button" aria-label="Show source information" aria-pressed="false">i</button>
          </div>
        </div>
        <div class="map-stage">
          <div
            id="world-map"
            class="world-map"
            role="application"
            aria-label="Map. Use arrow keys to pan and plus or minus to zoom."
          ></div>
          <span id="data-status" class="map-overlay map-overlay-right" aria-live="polite" hidden>DEM …</span>
          <div class="map-search">
            <button class="tool square" id="search-toggle" type="button" aria-expanded="false" aria-controls="place-search" aria-label="Find a place">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2" />
                <path d="M15.4 15.4 21 21" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
              </svg>
            </button>
            <form class="map-search-form" id="place-search" hidden>
              <label class="sr-only" for="place-query">Find a place, coordinates, or a map link</label>
              <input id="place-query" type="search" autocomplete="off" spellcheck="false"
                placeholder="PLACE · 27.9881, 86.9250 · MAP LINK" />
            </form>
          </div>
        </div>
        <div class="transect-bar">
          <div class="transect-control">
            <label for="slice-direction">DIRECTION <output id="slice-direction-value">090 DEG</output></label>
            <input id="slice-direction" type="range" min="0" max="359" step="1" value="90" />
          </div>
          <div class="transect-control">
            <label for="bank-position">POSITION <output id="bank-position-value">0.00</output></label>
            <input id="bank-position" type="range" min="-1" max="1" step="0.01" value="0" />
          </div>
        </div>
        <div id="info-panel" class="info-panel" hidden>
          <dl>
            <div><dt>AREA</dt><dd id="area-readout">-- × -- KM</dd></div>
            <div><dt>BOUNDS</dt><dd id="bounds-readout">--</dd></div>
            <div><dt>TERRAIN</dt><dd id="terrain-provider">LOADING</dd></div>
            <div><dt>DEM RESOLUTION</dt><dd id="dem-resolution">--</dd></div>
            <div><dt>DEM SOURCE</dt><dd id="dem-source">--</dd></div>
            <div><dt>SEED</dt><dd id="seed-readout">--</dd></div>
          </dl>
          <p id="map-attribution" class="info-attribution">MAP DATA © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OPENSTREETMAP CONTRIBUTORS</a>, SRTM / STYLE © <a href="https://opentopomap.org/" target="_blank" rel="noopener noreferrer">OPENTOPOMAP</a> (CC-BY-SA)</p>
          <p class="info-attribution">
            TERRAIN: <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener noreferrer">MAPZEN TERRAIN TILES / AWS OPEN DATA</a>
            · <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener noreferrer">FULL SOURCE CREDITS</a>
          </p>
        </div>
      </figure>

      <aside class="controls" aria-label="Instrument">
        <section class="panel module">
          <h2>
            <span id="voice-title">CYCLE</span>
            <span class="voice-tabs">
              <button class="tool is-active" id="voice-wavetable" type="button" aria-pressed="true">WAVE</button>
              <button class="tool" id="voice-bore" type="button" aria-pressed="false">BORE</button>
            </span>
          </h2>
          <div id="wavetable-controls">
            <label for="harmonics">HARMONICS <output id="harmonics-value">64</output></label>
            <input id="harmonics" type="range" min="0" max="1" step="0.001" value="0.714" />
            <div class="toggle-row">
              <button class="tool" id="mirror" type="button" aria-pressed="false">MIRROR</button>
              <button class="tool is-active" id="normalize" type="button" aria-pressed="true">NORM</button>
            </div>
          </div>
          <div id="bore-controls" hidden>
            <label for="bore-depth">DEPTH <output id="bore-depth-value">2.00</output></label>
            <input id="bore-depth" type="range" min="0.25" max="3" step="0.05" value="2" />
            <label for="bore-decay">DECAY <output id="bore-decay-value">0.85</output></label>
            <input id="bore-decay" type="range" min="0" max="1" step="0.01" value="0.85" />
            <label for="bore-tone">TONE <output id="bore-tone-value">0.89</output></label>
            <input id="bore-tone" type="range" min="0" max="1" step="0.01" value="0.89" />
            <label for="bore-blow">BLOW <output id="bore-blow-value">0.50</output></label>
            <input id="bore-blow" type="range" min="0" max="1" step="0.01" value="0.50" />
            <label for="bore-width">WIDTH <output id="bore-width-value">MONO</output></label>
            <input id="bore-width" type="range" min="0" max="1" step="0.01" value="0" />
            <div class="toggle-row">
              <button class="tool" id="bore-temper" type="button" aria-pressed="false">TEMPER</button>
            </div>
          </div>
        </section>

        <section class="panel module">
          <h2><span>SCAN</span><button class="tool" id="scan-toggle" type="button" aria-pressed="false">OFF</button></h2>
          <label for="scan-rate">RATE <output id="scan-rate-value">0.20 HZ</output></label>
          <input id="scan-rate" type="range" min="0.02" max="2" step="0.01" value="0.2" />
          <label for="scan-depth">DEPTH <output id="scan-depth-value">1.00</output></label>
          <input id="scan-depth" type="range" min="0" max="1" step="0.01" value="1" />
          <label for="scan-smooth">SMOOTH <output id="scan-smooth-value">0.30</output></label>
          <input id="scan-smooth" type="range" min="0" max="1" step="0.01" value="0.3" />
        </section>

        <section class="panel module play-module">
          <h2>PLAY</h2>
          <label for="attack">ATTACK <output id="attack-value">0.020 S</output></label>
          <input id="attack" type="range" min="0.003" max="1" step="0.001" value="0.02" />
          <label for="release">RELEASE <output id="release-value">0.300 S</output></label>
          <input id="release" type="range" min="0.02" max="2" step="0.01" value="0.3" />
          <div class="note-keyboard" aria-label="Keyboard">
            <div class="white-keys">
              <button type="button" data-midi="60" aria-label="C, keyboard A">C4<small>A</small></button>
              <button type="button" data-midi="62" aria-label="D, keyboard S">D<small>S</small></button>
              <button type="button" data-midi="64" aria-label="E, keyboard D">E<small>D</small></button>
              <button type="button" data-midi="65" aria-label="F, keyboard F">F<small>F</small></button>
              <button type="button" data-midi="67" aria-label="G, keyboard G">G<small>G</small></button>
              <button type="button" data-midi="69" aria-label="A, keyboard H">A<small>H</small></button>
              <button type="button" data-midi="71" aria-label="B, keyboard J">B<small>J</small></button>
              <button type="button" data-midi="72" aria-label="C, keyboard K">C5<small>K</small></button>
            </div>
            <div class="black-keys">
              <button type="button" data-midi="61" style="--slot: 0" aria-label="C sharp, keyboard W"><small>W</small></button>
              <button type="button" data-midi="63" style="--slot: 1" aria-label="D sharp, keyboard E"><small>E</small></button>
              <button type="button" data-midi="66" style="--slot: 3" aria-label="F sharp, keyboard T"><small>T</small></button>
              <button type="button" data-midi="68" style="--slot: 4" aria-label="G sharp, keyboard Y"><small>Y</small></button>
              <button type="button" data-midi="70" style="--slot: 5" aria-label="A sharp, keyboard U"><small>U</small></button>
            </div>
          </div>
          <div class="octave-row">
            <button class="tool octave-step" id="octave-down" type="button" aria-label="Octave down, keyboard Z"><span>−</span><small>Z</small></button>
            <span class="octave-readout">OCT <output id="octave-value">4</output></span>
            <button class="tool octave-step" id="octave-up" type="button" aria-label="Octave up, keyboard X"><span>+</span><small>X</small></button>
          </div>
        </section>

        <section class="panel module">
          <h2>OUTPUT</h2>
          <div class="transport">
            <button id="hold" class="primary-action" type="button" aria-pressed="false" disabled><span id="play-label">PLAY C4</span><small>SPACE</small></button>
          </div>
          <div class="export-row">
            <button id="open-export" class="tool" type="button" disabled>EXPORT</button>
          </div>
          <div class="session-row">
            <button id="save-session" class="tool" type="button" disabled>SAVE</button>
            <button id="open-session" class="tool" type="button">OPEN</button>
            <input id="session-file" class="sr-only" type="file" accept=".json,application/json" />
          </div>
          <div id="audio-status" class="audio-status" aria-live="polite">…</div>
        </section>
      </aside>

      <div class="visual-grid">
        <figure class="panel visual-panel">
          <figcaption>TERRAIN</figcaption>
          <canvas id="terrain" aria-label="Terrain height grid and active transect"></canvas>
          <div class="readout"><span id="terrain-range">--</span></div>
        </figure>

        <figure class="panel visual-panel">
          <figcaption>WAVETABLE</figcaption>
          <canvas id="wavetable" aria-label="Elevation profile and derived wavetable cycle"></canvas>
          <div class="readout"><span id="transect-length">--</span><span id="profile-range">--</span></div>
        </figure>
      </div>
    </section>

    <dialog id="export-dialog" class="export-dialog" tabindex="-1" aria-labelledby="export-title">
      <form id="export-form" method="dialog">
        <h2 id="export-title">EXPORT</h2>
        <ul class="export-items">
          <li id="export-item-serum">
            <label>
              <input type="checkbox" name="export-item" value="serum" checked />
              <span class="export-item-name">WAVETABLE BANK</span>
              <span class="export-item-params">${EXPORT_FRAME_COUNT} × ${WAVETABLE_FRAME_SAMPLES} · CLM</span>
              <span class="export-item-size" id="export-size-serum"></span>
              <span class="export-item-target">SERUM · VITAL · BITWIG</span>
            </label>
          </li>
          <li id="export-item-ableton">
            <label>
              <input type="checkbox" name="export-item" value="ableton" checked />
              <span class="export-item-name">WAVETABLE BANK</span>
              <span class="export-item-params">${EXPORT_FRAME_COUNT} × ${ABLETON_FRAME_SAMPLES}</span>
              <span class="export-item-size" id="export-size-ableton"></span>
              <span class="export-item-target">ABLETON</span>
            </label>
          </li>
          <li id="export-item-cycle">
            <label>
              <input type="checkbox" name="export-item" value="cycle" />
              <span class="export-item-name">SINGLE CYCLE</span>
              <span class="export-item-params">1 × ${WAVETABLE_FRAME_SAMPLES}</span>
              <span class="export-item-size" id="export-size-cycle"></span>
              <span class="export-item-target">SAMPLER · BUFFER~</span>
            </label>
          </li>
          <li id="export-item-multisample" hidden>
            <label>
              <input type="checkbox" name="export-item" value="multisample" checked />
              <span class="export-item-name">MULTISAMPLE</span>
              <span class="export-item-params" id="export-params-multisample">--</span>
              <span class="export-item-size" id="export-size-multisample"></span>
              <span class="export-item-target">SAMPLER</span>
            </label>
          </li>
          <li id="export-item-sfz" hidden>
            <label>
              <input type="checkbox" name="export-item" value="sfz" checked />
              <span class="export-item-name">KEY MAP</span>
              <span class="export-item-params">SFZ</span>
              <span class="export-item-size" id="export-size-sfz"></span>
            </label>
          </li>
          <li id="export-item-metadata">
            <label>
              <input type="checkbox" name="export-item" value="metadata" checked />
              <span class="export-item-name">METADATA</span>
              <span class="export-item-params">JSON</span>
              <span class="export-item-size" id="export-size-metadata"></span>
              <span class="export-item-target">BOUNDS · DEM · SETTINGS</span>
            </label>
          </li>
          <li id="export-item-relief">
            <label>
              <input type="checkbox" name="export-item" value="relief" />
              <span class="export-item-name">RELIEF PROFILE</span>
              <span class="export-item-params">${RELIEF_SECTIONS} × FLOAT</span>
              <span class="export-item-size" id="export-size-relief"></span>
              <span class="export-item-target">JSON</span>
            </label>
          </li>
        </ul>
        <div class="export-footer">
          <span id="export-format">44.1 KHZ · 16-BIT PCM · MONO</span>
          <span id="export-summary"></span>
        </div>
        <p id="export-error" class="export-error" role="alert" hidden></p>
        <div class="export-actions">
          <button class="tool" value="cancel" type="submit">CANCEL</button>
          <button id="export-submit" class="primary-action" value="export" type="submit">EXPORT</button>
        </div>
      </form>
    </dialog>
  </main>
`;

function requiredElement(selector, constructor) {
  const element = document.querySelector(selector);
  if (!(element instanceof constructor)) throw new Error(`Required element is missing or invalid: ${selector}`);
  return element;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function seedFromBounds(bounds) {
  const text = [bounds.west, bounds.south, bounds.east, bounds.north].map((value) => value.toFixed(5)).join(":");
  let hash = FOUNDATION_SEED;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

const textEncoder = new TextEncoder();

const elements = {
  terrainCanvas: requiredElement("#terrain", HTMLCanvasElement),
  wavetableCanvas: requiredElement("#wavetable", HTMLCanvasElement),
  map: requiredElement("#world-map", HTMLElement),
  sliceDirection: requiredElement("#slice-direction", HTMLInputElement),
  bankPosition: requiredElement("#bank-position", HTMLInputElement),
  harmonics: requiredElement("#harmonics", HTMLInputElement),
  mirror: requiredElement("#mirror", HTMLButtonElement),
  normalize: requiredElement("#normalize", HTMLButtonElement),
  voiceTitle: requiredElement("#voice-title", HTMLElement),
  voiceWavetable: requiredElement("#voice-wavetable", HTMLButtonElement),
  voiceBore: requiredElement("#voice-bore", HTMLButtonElement),
  wavetableControls: requiredElement("#wavetable-controls", HTMLElement),
  boreControls: requiredElement("#bore-controls", HTMLElement),
  boreDepth: requiredElement("#bore-depth", HTMLInputElement),
  boreDecay: requiredElement("#bore-decay", HTMLInputElement),
  boreTone: requiredElement("#bore-tone", HTMLInputElement),
  boreBlow: requiredElement("#bore-blow", HTMLInputElement),
  boreWidth: requiredElement("#bore-width", HTMLInputElement),
  boreTemper: requiredElement("#bore-temper", HTMLButtonElement),
  newArea: requiredElement("#new-area", HTMLButtonElement),
  scanToggle: requiredElement("#scan-toggle", HTMLButtonElement),
  scanRate: requiredElement("#scan-rate", HTMLInputElement),
  scanDepth: requiredElement("#scan-depth", HTMLInputElement),
  scanSmooth: requiredElement("#scan-smooth", HTMLInputElement),
  attack: requiredElement("#attack", HTMLInputElement),
  release: requiredElement("#release", HTMLInputElement),
  playLabel: requiredElement("#play-label", HTMLElement),
  hold: requiredElement("#hold", HTMLButtonElement),
  octaveDown: requiredElement("#octave-down", HTMLButtonElement),
  octaveUp: requiredElement("#octave-up", HTMLButtonElement),
  openExport: requiredElement("#open-export", HTMLButtonElement),
  saveSession: requiredElement("#save-session", HTMLButtonElement),
  openSession: requiredElement("#open-session", HTMLButtonElement),
  sessionFile: requiredElement("#session-file", HTMLInputElement),
  exportDialog: requiredElement("#export-dialog", HTMLDialogElement),
  exportForm: requiredElement("#export-form", HTMLFormElement),
  exportSubmit: requiredElement("#export-submit", HTMLButtonElement),
  exportSummary: requiredElement("#export-summary", HTMLElement),
  searchToggle: requiredElement("#search-toggle", HTMLButtonElement),
  searchForm: requiredElement("#place-search", HTMLFormElement),
  searchQuery: requiredElement("#place-query", HTMLInputElement),
  exportItemSerum: requiredElement("#export-item-serum", HTMLElement),
  exportItemAbleton: requiredElement("#export-item-ableton", HTMLElement),
  exportItemCycle: requiredElement("#export-item-cycle", HTMLElement),
  exportItemMultisample: requiredElement("#export-item-multisample", HTMLElement),
  exportItemSfz: requiredElement("#export-item-sfz", HTMLElement),
  exportParamsMultisample: requiredElement("#export-params-multisample", HTMLElement),
  exportError: requiredElement("#export-error", HTMLElement),
  sliceDirectionValue: requiredElement("#slice-direction-value", HTMLOutputElement),
  bankPositionValue: requiredElement("#bank-position-value", HTMLOutputElement),
  harmonicsValue: requiredElement("#harmonics-value", HTMLOutputElement),
  scanRateValue: requiredElement("#scan-rate-value", HTMLOutputElement),
  scanDepthValue: requiredElement("#scan-depth-value", HTMLOutputElement),
  scanSmoothValue: requiredElement("#scan-smooth-value", HTMLOutputElement),
  attackValue: requiredElement("#attack-value", HTMLOutputElement),
  releaseValue: requiredElement("#release-value", HTMLOutputElement),
  boreDepthValue: requiredElement("#bore-depth-value", HTMLOutputElement),
  boreDecayValue: requiredElement("#bore-decay-value", HTMLOutputElement),
  boreToneValue: requiredElement("#bore-tone-value", HTMLOutputElement),
  boreBlowValue: requiredElement("#bore-blow-value", HTMLOutputElement),
  boreWidthValue: requiredElement("#bore-width-value", HTMLOutputElement),
  octaveValue: requiredElement("#octave-value", HTMLOutputElement),
  transectLength: requiredElement("#transect-length", HTMLElement),
  profileRange: requiredElement("#profile-range", HTMLElement),
  terrainRange: requiredElement("#terrain-range", HTMLElement),
  areaReadout: requiredElement("#area-readout", HTMLElement),
  boundsReadout: requiredElement("#bounds-readout", HTMLElement),
  terrainProvider: requiredElement("#terrain-provider", HTMLElement),
  demResolution: requiredElement("#dem-resolution", HTMLElement),
  demSource: requiredElement("#dem-source", HTMLElement),
  seedReadout: requiredElement("#seed-readout", HTMLElement),
  audioStatus: requiredElement("#audio-status", HTMLElement),
  dataStatus: requiredElement("#data-status", HTMLElement),
  mapAttribution: requiredElement("#map-attribution", HTMLElement),
  infoToggle: requiredElement("#info-toggle", HTMLButtonElement),
  infoPanel: requiredElement("#info-panel", HTMLElement),
};

let sessionSaveTimer = 0;
let selection = { ...DEFAULT_SELECTION };
let terrain;
let wavetable;
let currentSeed = FOUNDATION_SEED;
let terrainRequest = null;
let terrainLoading = true;
let searchPending = false;
let octaveOffset = 0;
let profileBank = null;
let bankTerrain = null;
let bankBearingDeg = null;
let scanSmoothing = null;
let drawnWavetable = null;
let scanning = false;
let scanStartTime = 0;
let activeVoice = "wavetable";
const wavetableInstrument = new WavetableInstrument();
const boreInstrument = new BoreInstrument();

function activeInstrument() {
  return activeVoice === "bore" ? boreInstrument : wavetableInstrument;
}

function currentBoreParameters() {
  return {
    depth: Number(elements.boreDepth.value),
    decay: Number(elements.boreDecay.value),
    tone: Number(elements.boreTone.value),
    blow: Number(elements.boreBlow.value),
    width: Number(elements.boreWidth.value),
    temper: isPressed(elements.boreTemper),
  };
}

let boreProfiles = { left: null, right: null, separationMeters: 0 };

function boreReliefProfiles(parameters) {
  const width = Number(elements.boreWidth.value);
  if (width <= 0) return { left: wavetable.elevationMeters, right: null, separationMeters: 0 };
  const pointCount = wavetable.elevationMeters.length;
  const spread = stereoTransectPositions(parameters.position, width);
  return {
    left: transectProfile(terrain, parameters.bearingDeg, spread.left, pointCount).elevationMeters,
    right: transectProfile(terrain, parameters.bearingDeg, spread.right, pointCount).elevationMeters,
    separationMeters: transectSeparationMeters(terrain, parameters.bearingDeg, spread.separation),
  };
}
const scanClock = new Worker(URL.createObjectURL(new Blob([
  "let timer=null;onmessage=(event)=>{clearInterval(timer);timer=event.data>0?setInterval(()=>postMessage(0),event.data):null;};",
], { type: "text/javascript" })));
scanClock.onmessage = () => updateWavetable();

const worldMap = new WorldMap(elements.map, {
  center: DEFAULT_VIEW.center,
  zoom: DEFAULT_VIEW.zoom,
  selection,
  onSelection(bounds) {
    selection = bounds;
    rebuildGeometry();
  },
  onDrawArmedChange(armed) {
    setPressed(elements.newArea, armed);
  },
});

function isPressed(button) {
  return button.getAttribute("aria-pressed") === "true";
}

function setPressed(button, pressed) {
  button.setAttribute("aria-pressed", String(pressed));
  button.classList.toggle("is-active", pressed);
}

function scanPosition() {
  const center = Number(elements.bankPosition.value);
  if (!scanning) return center;
  const seconds = (performance.now() - scanStartTime) / 1_000;
  const phase = 2 * Math.PI * Number(elements.scanRate.value) * seconds;
  const reach = Number(elements.scanDepth.value) * (MAX_BANK_POSITION - Math.abs(center));
  return center + Math.sin(phase) * reach;
}

function currentWavetableParameters() {
  return {
    bearingDeg: Number(elements.sliceDirection.value),
    position: clamp(scanPosition(), -MAX_BANK_POSITION, MAX_BANK_POSITION),
    harmonicLimit: harmonicLimitFromSlider(Number(elements.harmonics.value)),
    seamMethod: isPressed(elements.mirror) ? "forward-reverse-mirror" : "direct-profile",
    normalize: isPressed(elements.normalize),
  };
}

function noteStatusText(midiNote) {
  if (activeVoice === "bore" && boreInstrument.silent) return "SILENT / NO RELIEF ON TRANSECT";
  return `${midiNoteFrequency(midiNote).toFixed(2)} HZ`;
}

function currentEnvelope() {
  return { attackSeconds: Number(elements.attack.value), releaseSeconds: Number(elements.release.value) };
}

function setDataStatus(state, text) {
  elements.dataStatus.classList.remove("is-ready", "is-error");
  if (state === "is-ready") {
    elements.dataStatus.hidden = true;
    elements.dataStatus.textContent = "";
    return;
  }
  elements.dataStatus.hidden = false;
  if (state) elements.dataStatus.classList.add(state);
  elements.dataStatus.textContent = text;
}

function updateAreaReadouts() {
  const dimensions = areaDimensions(selection);
  elements.areaReadout.textContent = `${(dimensions.widthMeters / 1_000).toFixed(1)} × ${(dimensions.heightMeters / 1_000).toFixed(1)} KM`;
  elements.boundsReadout.textContent = `${selection.west.toFixed(3)}, ${selection.south.toFixed(3)} / ${selection.east.toFixed(3)}, ${selection.north.toFixed(3)}`;
  elements.seedReadout.textContent = `0x${currentSeed.toString(16).toUpperCase().padStart(8, "0")}`;
}

function updateTransportAvailability() {
  elements.hold.disabled = terrainLoading || !terrain;
  elements.openExport.disabled = !wavetable;
  elements.saveSession.disabled = !terrain;
}

const TEXT_ENTRY_TYPES = new Set(["text", "search", "url", "email", "password", "number", "tel"]);

function isTypingTarget(target) {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target instanceof HTMLInputElement && TEXT_ENTRY_TYPES.has(target.type);
}

const noteButtons = new Map(
  [...document.querySelectorAll("[data-midi]")]
    .map((button) => [Number(button.dataset.midi), button]),
);

function noteButton(baseMidiNote) {
  return noteButtons.get(baseMidiNote);
}

function harmonicLimitFromSlider(value) {
  return Math.round(MINIMUM_HARMONICS * (MAXIMUM_HARMONICS / MINIMUM_HARMONICS) ** value);
}

function sliderFromHarmonicLimit(limit) {
  const bounded = Math.min(MAXIMUM_HARMONICS, Math.max(MINIMUM_HARMONICS, limit));
  return Math.log(bounded / MINIMUM_HARMONICS) / Math.log(MAXIMUM_HARMONICS / MINIMUM_HARMONICS);
}

function shiftedMidi(baseMidiNote) {
  return baseMidiNote + octaveOffset * 12;
}

function updateOctaveDisplay() {
  const octave = 4 + octaveOffset;
  elements.octaveValue.textContent = String(octave);
  elements.playLabel.textContent = `PLAY C${octave}`;
  noteButton(60).firstChild.textContent = `C${octave}`;
  noteButton(72).firstChild.textContent = `C${octave + 1}`;
}

function changeOctave(delta) {
  const next = clamp(octaveOffset + delta, MIN_OCTAVE_OFFSET, MAX_OCTAVE_OFFSET);
  if (next === octaveOffset) return;
  const semitones = (next - octaveOffset) * 12;
  octaveOffset = next;
  activeInstrument().transpose(semitones);
  updateOctaveDisplay();
  scheduleSessionSave();
}

function updateBoreReadouts() {
  elements.boreDepthValue.value = Number(elements.boreDepth.value).toFixed(2);
  elements.boreDecayValue.value = Number(elements.boreDecay.value).toFixed(2);
  elements.boreToneValue.value = Number(elements.boreTone.value).toFixed(2);
  elements.boreBlowValue.value = Number(elements.boreBlow.value).toFixed(2);
  updateWidthReadout();
}

function setVoice(voice) {
  const bore = voice === "bore";
  if (activeVoice !== voice) {
    activeInstrument().stopAll();
    setPressed(elements.hold, false);
    elements.audioStatus.textContent = "";
  }
  activeVoice = bore ? "bore" : "wavetable";
  setPressed(elements.voiceBore, bore);
  setPressed(elements.voiceWavetable, !bore);
  elements.voiceTitle.textContent = bore ? "BORE" : "CYCLE";
  elements.wavetableControls.hidden = bore;
  elements.boreControls.hidden = !bore;
  elements.exportItemSerum.hidden = bore;
  elements.exportItemAbleton.hidden = bore;
  elements.exportItemCycle.hidden = bore;
  elements.exportItemMultisample.hidden = !bore;
  elements.exportItemSfz.hidden = !bore;
  if (terrain && wavetable) updateExportSummary();
}

function soundingWavetable(target) {
  const amount = Number(elements.scanSmooth.value);
  if (!scanning || amount <= 0) {
    scanSmoothing = null;
    return target;
  }
  if (!scanSmoothing || scanSmoothing.real.length !== target.real.length) {
    scanSmoothing = {
      real: Float32Array.from(target.real),
      imaginary: Float32Array.from(target.imaginary),
      waveform: Float32Array.from(target.waveform),
    };
    return { ...target, ...scanSmoothing };
  }
  const alpha = Math.max(MINIMUM_SCAN_GLIDE, (1 - amount) ** 2);
  for (let index = 0; index < target.real.length; index += 1) {
    scanSmoothing.real[index] += (target.real[index] - scanSmoothing.real[index]) * alpha;
    scanSmoothing.imaginary[index] += (target.imaginary[index] - scanSmoothing.imaginary[index]) * alpha;
  }
  for (let index = 0; index < target.waveform.length; index += 1) {
    scanSmoothing.waveform[index] += (target.waveform[index] - scanSmoothing.waveform[index]) * alpha;
  }
  return { ...target, ...scanSmoothing };
}

function updateWidthReadout() {
  elements.boreWidthValue.value = Number(elements.boreWidth.value) > 0
    ? `${(boreProfiles.separationMeters / 1_000).toFixed(2)} KM`
    : "MONO";
}

function updateMapTransect() {
  const parameters = currentWavetableParameters();
  worldMap.setTransect({ bearingDeg: parameters.bearingDeg, position: parameters.position });
}

function updateWavetable() {
  updateMapTransect();
  if (!terrain) return;
  const parameters = currentWavetableParameters();
  if (bankTerrain !== terrain || bankBearingDeg !== parameters.bearingDeg) {
    profileBank = terrainProfileBank(terrain, { bearingDeg: parameters.bearingDeg });
    bankTerrain = terrain;
    bankBearingDeg = parameters.bearingDeg;
  }
  wavetable = buildTerrainWavetable(terrain, parameters);
  const sounding = soundingWavetable(wavetable);
  wavetableInstrument.setWavetable(sounding);
  boreProfiles = boreReliefProfiles(parameters);
  boreInstrument.setRelief(boreProfiles.left, boreProfiles.right);
  updateWidthReadout();
  if (activeVoice === "bore" && boreInstrument.voices.has("hold")) {
    elements.audioStatus.textContent = noteStatusText(boreInstrument.voices.get("hold").midiNote);
  }
  drawnWavetable = sounding;
  drawWavetable(elements.wavetableCanvas, sounding, profileBank);
  drawTerrain(elements.terrainCanvas, terrain, wavetable.transect);
  elements.sliceDirectionValue.value = `${Math.round(wavetable.transect.bearingDeg).toString().padStart(3, "0")} DEG`;
  elements.bankPositionValue.value = wavetable.transect.position.toFixed(2);
  elements.harmonicsValue.value = String(wavetable.maximumHarmonic);
  elements.transectLength.textContent = `${(wavetable.transect.lengthMeters / 1_000).toFixed(2)} KM`;
  elements.profileRange.textContent = `${wavetable.minimumElevationMeters.toFixed(0)}–${wavetable.maximumElevationMeters.toFixed(0)} M`;
  updateTransportAvailability();
}

function applyTerrain(nextTerrain) {
  terrain = nextTerrain;
  worldMap.setTerrainOverlay(terrain.provider === "mapzen-terrain-tiles-aws" ? terrain : null);
  elements.terrainRange.textContent = `${terrain.minimumElevationMeters.toFixed(0)}–${terrain.maximumElevationMeters.toFixed(0)} M`;
  elements.terrainProvider.textContent = terrain.provider === "mapzen-terrain-tiles-aws" ? "REAL DEM / MAPZEN-AWS" : "SYNTHETIC FALLBACK";
  elements.demResolution.textContent = `${terrain.resolutionMeters.toFixed(1)} M NATIVE / ${terrain.size}×${terrain.size} GRID`;
  updateWavetable();
}

async function rebuildGeometry() {
  terrainRequest?.abort();
  terrainRequest = new AbortController();
  const request = terrainRequest;
  const extent = analysisExtent(selection);
  currentSeed = seedFromBounds(selection);
  terrainLoading = true;
  updateMapTransect();
  updateAreaReadouts();
  updateTransportAvailability();
  setDataStatus("", "DEM LOADING");

  try {
    const realTerrain = await loadTerrainGrid(selection, {
      size: ANALYSIS_GRID_SIZE,
      widthMeters: extent.widthMeters,
      heightMeters: extent.heightMeters,
      signal: request.signal,
    });
    if (request !== terrainRequest) return;
    applyTerrain(realTerrain);
    setDataStatus("is-ready", "DEM READY");
    elements.demSource.textContent = `Z${realTerrain.zoom} / ${realTerrain.tileCount} TILE${realTerrain.tileCount === 1 ? "" : "S"} / ${realTerrain.imagerySources.join(" + ") || "SOURCE METADATA UNAVAILABLE"}`;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    console.error(error);
    applyTerrain(createFoundationTerrain({
      seed: currentSeed,
      widthMeters: extent.widthMeters,
      heightMeters: extent.heightMeters,
    }));
    setDataStatus("is-error", "DEM FALLBACK");
    elements.demSource.textContent = `LOAD FAILED / SYNTHETIC FALLBACK / ${error instanceof Error ? error.message.toUpperCase() : "UNKNOWN ERROR"}`;
  } finally {
    if (request === terrainRequest) {
      terrainLoading = false;
      updateTransportAvailability();
    }
  }
}

function patchFileStem() {
  return `geoflute-${currentSeed.toString(16).padStart(8, "0")}-${Math.round(Number(elements.sliceDirection.value)).toString().padStart(3, "0")}deg`;
}

function patchDocument() {
  const dimensions = areaDimensions(selection);
  const parameters = currentWavetableParameters();
  return createPatch({
    selection,
    widthMeters: dimensions.widthMeters,
    heightMeters: dimensions.heightMeters,
    provider: terrain.provider,
    resolutionMeters: terrain.resolutionMeters,
    gridSize: terrain.size,
    elevationRangeMeters: [terrain.minimumElevationMeters, terrain.maximumElevationMeters],
    view: worldMap.viewState(),
    bearingDeg: parameters.bearingDeg,
    bankPosition: Number(elements.bankPosition.value),
    harmonicLimit: parameters.harmonicLimit,
    seamMethod: parameters.seamMethod,
    normalized: parameters.normalize,
    cycleSamples: WAVETABLE_FRAME_SAMPLES,
    octaveOffset,
    attackSeconds: Number(elements.attack.value),
    releaseSeconds: Number(elements.release.value),
    scanRateHz: Number(elements.scanRate.value),
    scanDepth: Number(elements.scanDepth.value),
    scanSmooth: Number(elements.scanSmooth.value),
    voice: activeVoice,
    boreDepth: Number(elements.boreDepth.value),
    boreDecay: Number(elements.boreDecay.value),
    boreTone: Number(elements.boreTone.value),
    boreBlow: Number(elements.boreBlow.value),
    boreWidth: Number(elements.boreWidth.value),
    boreSeparationMeters: boreProfiles.separationMeters,
    boreTemper: isPressed(elements.boreTemper),
    seed: currentSeed,
  });
}

function applyPatch(patch) {
  stopScan();
  activeInstrument().stopAll();
  setPressed(elements.hold, false);
  octaveOffset = patch.octaveOffset;
  elements.sliceDirection.value = String(patch.bearingDeg);
  elements.bankPosition.value = String(patch.bankPosition);
  elements.harmonics.value = String(sliderFromHarmonicLimit(patch.harmonicLimit));
  elements.attack.value = String(patch.attackSeconds);
  elements.release.value = String(patch.releaseSeconds);
  elements.scanRate.value = String(patch.scanRateHz);
  elements.scanDepth.value = String(patch.scanDepth);
  elements.scanSmooth.value = String(patch.scanSmooth);
  elements.boreDepth.value = String(patch.boreDepth);
  elements.boreDecay.value = String(patch.boreDecay);
  elements.boreTone.value = String(patch.boreTone);
  elements.boreBlow.value = String(patch.boreBlow);
  elements.boreWidth.value = String(patch.boreWidth);
  setPressed(elements.boreTemper, patch.boreTemper);
  setPressed(elements.mirror, patch.seamMethod === "forward-reverse-mirror");
  setPressed(elements.normalize, patch.normalized);
  elements.attackValue.value = `${patch.attackSeconds.toFixed(3)} S`;
  elements.releaseValue.value = `${patch.releaseSeconds.toFixed(3)} S`;
  elements.scanRateValue.value = `${patch.scanRateHz.toFixed(2)} HZ`;
  elements.scanDepthValue.value = patch.scanDepth.toFixed(2);
  elements.scanSmoothValue.value = patch.scanSmooth.toFixed(2);
  updateBoreReadouts();
  setVoice(patch.voice);
  boreInstrument.setParameters(currentBoreParameters());
  updateOctaveDisplay();
  selection = patch.selection;
  worldMap.setSelection(selection);
  worldMap.setView({ longitude: patch.view.longitude, latitude: patch.view.latitude }, patch.view.zoom);
  rebuildGeometry();
}

function scheduleSessionSave() {
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveSession, SESSION_SAVE_DELAY_MS);
}

function saveSession() {
  clearTimeout(sessionSaveTimer);
  if (!terrain) return;
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(patchDocument()));
  } catch {
    return;
  }
}

function restoreSession() {
  let stored;
  try {
    stored = localStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return false;
  }
  if (!stored) return false;
  try {
    applyPatch(parsePatch(stored));
    return true;
  } catch {
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      return false;
    }
    return false;
  }
}

function stopScan() {
  if (!scanning) return;
  scanning = false;
  scanClock.postMessage(0);
  scanSmoothing = null;
  setPressed(elements.scanToggle, false);
  elements.scanToggle.textContent = "OFF";
  updateWavetable();
}

function startScan() {
  if (scanning) return;
  scanning = true;
  scanStartTime = performance.now();
  scanClock.postMessage(SCAN_UPDATE_INTERVAL_MS);
  setPressed(elements.scanToggle, true);
  elements.scanToggle.textContent = "ON";
}

for (const input of [elements.sliceDirection, elements.bankPosition, elements.harmonics]) {
  input.addEventListener("input", () => updateWavetable());
}
for (const input of [elements.attack, elements.release]) {
  input.addEventListener("input", () => {
    elements.attackValue.value = `${Number(elements.attack.value).toFixed(3)} S`;
    elements.releaseValue.value = `${Number(elements.release.value).toFixed(3)} S`;
  });
}
for (const input of [elements.scanRate, elements.scanDepth, elements.scanSmooth]) {
  input.addEventListener("input", () => {
    elements.scanRateValue.value = `${Number(elements.scanRate.value).toFixed(2)} HZ`;
    elements.scanDepthValue.value = Number(elements.scanDepth.value).toFixed(2);
    elements.scanSmoothValue.value = Number(elements.scanSmooth.value).toFixed(2);
  });
}
for (const button of [elements.mirror, elements.normalize]) {
  button.addEventListener("click", () => {
    setPressed(button, !isPressed(button));
    updateWavetable();
  });
}
for (const input of [elements.boreDepth, elements.boreDecay, elements.boreTone, elements.boreBlow]) {
  input.addEventListener("input", () => {
    updateBoreReadouts();
    boreInstrument.setParameters(currentBoreParameters());
    scheduleSessionSave();
  });
}
elements.boreWidth.addEventListener("input", () => {
  boreInstrument.setParameters(currentBoreParameters());
  updateWavetable();
  scheduleSessionSave();
});
elements.boreTemper.addEventListener("click", () => {
  setPressed(elements.boreTemper, !isPressed(elements.boreTemper));
  boreInstrument.setParameters(currentBoreParameters());
  scheduleSessionSave();
});
elements.voiceWavetable.addEventListener("click", () => {
  setVoice("wavetable");
  scheduleSessionSave();
});
elements.voiceBore.addEventListener("click", () => {
  setVoice("bore");
  scheduleSessionSave();
});
elements.scanToggle.addEventListener("click", () => {
  if (!scanning) startScan();
  else stopScan();
});
elements.newArea.addEventListener("click", () => {
  worldMap.armDraw(!isPressed(elements.newArea));
});
for (const layerButton of document.querySelectorAll("[data-base-layer]")) {
  layerButton.addEventListener("click", () => {
    const provider = layerButton.dataset.baseLayer;
    worldMap.setProvider(provider);
    for (const button of document.querySelectorAll("[data-base-layer]")) button.classList.toggle("is-active", button === layerButton);
    elements.mapAttribution.innerHTML = provider === "relief"
      ? 'MAP DATA © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OPENSTREETMAP CONTRIBUTORS</a>, SRTM / STYLE © <a href="https://opentopomap.org/" target="_blank" rel="noopener noreferrer">OPENTOPOMAP</a> (CC-BY-SA)'
      : 'MAP © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OPENSTREETMAP CONTRIBUTORS</a>';
  });
}

for (const button of document.querySelectorAll("[data-midi]")) {
  const releasePointerNote = (event) => {
    activeInstrument().noteOff(`pointer:${event.pointerId}`, Number(elements.release.value));
    button.classList.remove("is-active");
  };
  button.addEventListener("pointerdown", async (event) => {
    if (terrainLoading) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    button.classList.add("is-active");
    const midiNote = shiftedMidi(Number(button.dataset.midi));
    try {
      const played = await activeInstrument().noteOn(`pointer:${event.pointerId}`, midiNote, currentEnvelope());
      elements.audioStatus.textContent = played ? noteStatusText(midiNote) : "SILENT / NO RELIEF ON TRANSECT";
    } catch (error) {
      elements.audioStatus.textContent = error instanceof Error ? error.message.toUpperCase() : "AUDIO ERROR";
    }
  });
  button.addEventListener("pointerup", releasePointerNote);
  button.addEventListener("pointercancel", releasePointerNote);
  button.addEventListener("lostpointercapture", releasePointerNote);
}

document.addEventListener("keydown", async (event) => {
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;

  if (event.code === "Space") {
    if (event.target instanceof HTMLButtonElement) return;
    event.preventDefault();
    await toggleHold();
    return;
  }

  if (event.code === "KeyZ" || event.code === "KeyX") {
    event.preventDefault();
    changeOctave(event.code === "KeyZ" ? -1 : 1);
    return;
  }

  const baseMidiNote = KEYBOARD_NOTES.get(event.code);
  if (baseMidiNote === undefined) return;
  event.preventDefault();
  const midiNote = shiftedMidi(baseMidiNote);
  noteButton(baseMidiNote)?.classList.add("is-active");
  try {
    const played = await activeInstrument().noteOn(`key:${event.code}`, midiNote, currentEnvelope());
    elements.audioStatus.textContent = played ? noteStatusText(midiNote) : "SILENT / NO RELIEF ON TRANSECT";
  } catch (error) {
    elements.audioStatus.textContent = error instanceof Error ? error.message.toUpperCase() : "AUDIO ERROR";
  }
});
document.addEventListener("keyup", (event) => {
  const baseMidiNote = KEYBOARD_NOTES.get(event.code);
  if (baseMidiNote === undefined) return;
  noteButton(baseMidiNote)?.classList.remove("is-active");
  activeInstrument().noteOff(`key:${event.code}`, Number(elements.release.value));
});

function setSearchOpen(open) {
  elements.searchForm.hidden = !open;
  elements.searchToggle.classList.toggle("is-active", open);
  elements.searchToggle.setAttribute("aria-expanded", String(open));
  if (open) elements.searchQuery.focus();
  else elements.searchQuery.setCustomValidity("");
}

function moveSelectionTo(position) {
  const halfLongitude = (selection.east - selection.west) / 2;
  const halfLatitude = (selection.north - selection.south) / 2;
  const latitude = clamp(
    position.latitude,
    -MAX_SELECTION_LATITUDE + halfLatitude,
    MAX_SELECTION_LATITUDE - halfLatitude,
  );
  selection = {
    west: position.longitude - halfLongitude,
    east: position.longitude + halfLongitude,
    south: latitude - halfLatitude,
    north: latitude + halfLatitude,
  };
  worldMap.setSelection(selection);
  worldMap.fitBounds(selection);
  rebuildGeometry();
}

elements.searchToggle.addEventListener("click", () => setSearchOpen(elements.searchForm.hidden));

elements.searchQuery.addEventListener("input", () => elements.searchQuery.setCustomValidity(""));

elements.searchQuery.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.stopPropagation();
  setSearchOpen(false);
  elements.searchToggle.focus();
});

elements.searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = elements.searchQuery.value.trim();
  if (!query || searchPending) return;
  searchPending = true;
  elements.searchQuery.setCustomValidity("");
  elements.searchForm.setAttribute("aria-busy", "true");
  try {
    const position = await findPlace(query);
    if (!position) {
      elements.searchQuery.setCustomValidity("No matching place was found.");
      elements.searchQuery.reportValidity();
      return;
    }
    moveSelectionTo(position);
    elements.searchQuery.value = "";
    setSearchOpen(false);
  } catch (error) {
    elements.searchQuery.setCustomValidity(error instanceof Error ? error.message : "The place search failed.");
    elements.searchQuery.reportValidity();
  } finally {
    searchPending = false;
    elements.searchForm.removeAttribute("aria-busy");
  }
});

requiredElement("#zoom-in", HTMLButtonElement).addEventListener("click", () => worldMap.zoomStep(1));
requiredElement("#zoom-out", HTMLButtonElement).addEventListener("click", () => worldMap.zoomStep(-1));
requiredElement("#view-world", HTMLButtonElement).addEventListener("click", () => worldMap.setView({ longitude: 0, latitude: 15 }, 2));
elements.infoToggle.addEventListener("click", () => {
  const open = elements.infoPanel.hidden;
  elements.infoPanel.hidden = !open;
  setPressed(elements.infoToggle, open);
});

elements.saveSession.addEventListener("click", () => {
  if (!terrain) return;
  downloadBlob(
    new Blob([`${JSON.stringify(patchDocument(), null, 2)}\n`], { type: "application/json" }),
    `${patchFileStem()}.geoflute.json`,
  );
  elements.audioStatus.textContent = "SESSION SAVED";
});

elements.openSession.addEventListener("click", () => elements.sessionFile.click());

elements.sessionFile.addEventListener("change", async (event) => {
  const [file] = event.currentTarget.files;
  event.currentTarget.value = "";
  if (!file) return;
  try {
    applyPatch(parsePatch(await file.text()));
    saveSession();
    elements.audioStatus.textContent = "SESSION OPENED";
  } catch (error) {
    elements.audioStatus.textContent = error instanceof Error ? error.message.toUpperCase() : "SESSION ERROR";
  }
});

elements.octaveDown.addEventListener("click", () => changeOctave(-1));
elements.octaveUp.addEventListener("click", () => changeOctave(1));

async function toggleHold() {
  if (isPressed(elements.hold)) {
    activeInstrument().noteOff("hold", Number(elements.release.value));
    setPressed(elements.hold, false);
    elements.audioStatus.textContent = "";
    return;
  }
  const midiNote = shiftedMidi(60);
  try {
    const played = await activeInstrument().noteOn("hold", midiNote, currentEnvelope());
    setPressed(elements.hold, played);
    elements.audioStatus.textContent = played ? noteStatusText(midiNote) : "SILENT / NO RELIEF ON TRANSECT";
  } catch (error) {
    elements.audioStatus.textContent = error instanceof Error ? error.message.toUpperCase() : "AUDIO ERROR";
  }
}

elements.hold.addEventListener("click", toggleHold);

function exportSelection() {
  return new Set(
    [...elements.exportForm.querySelectorAll('input[name="export-item"]')]
      .filter((input) => (
        input instanceof HTMLInputElement && input.checked && !input.closest("li").hidden
      ))
      .map((input) => input.value),
  );
}

function reliefDocument() {
  const dimensions = areaDimensions(selection);
  return createReliefProfile({
    selection,
    widthMeters: dimensions.widthMeters,
    heightMeters: dimensions.heightMeters,
    provider: terrain.provider,
    resolutionMeters: terrain.resolutionMeters,
    gridSize: terrain.size,
    bearingDeg: wavetable.transect.bearingDeg,
    bankPosition: wavetable.transect.position,
    lengthMeters: wavetable.transect.lengthMeters,
    elevationMeters: resampleProfile(wavetable.elevationMeters, RELIEF_SECTIONS),
    seed: currentSeed,
  });
}

function documentByteLength(patch) {
  return textByteLength(`${JSON.stringify(patch, null, 2)}\n`);
}

function textByteLength(text) {
  return textEncoder.encode(text).length;
}

function boreExportNotes() {
  return multisampleNoteList(shiftedMidi(60));
}

function boreExportFileNames(stem, notes) {
  return notes.map((midiNote) => `${stem}-${midiNoteName(midiNote).replace("#", "s")}.wav`);
}

function boreExportSfz(stem) {
  const notes = boreExportNotes();
  const fileNames = boreExportFileNames(stem, notes);
  const keyRanges = multisampleKeyRanges(notes);
  return sfzDocument({ fileNames, keyRanges, releaseSeconds: Number(elements.release.value) });
}

function exportItemSizes() {
  const stem = patchFileStem();
  const notes = boreExportNotes();
  const noteSeconds = EXPORT_SUSTAIN_SECONDS + Number(elements.release.value) + EXPORT_TAIL_SECONDS;
  const noteSamples = Math.ceil(noteSeconds * AUDIO_SAMPLE_RATE);
  return {
    serum: wavetableWavByteLength(EXPORT_FRAME_COUNT * WAVETABLE_FRAME_SAMPLES, {
      cycleSamples: WAVETABLE_FRAME_SAMPLES,
    }),
    ableton: wavetableWavByteLength(EXPORT_FRAME_COUNT * ABLETON_FRAME_SAMPLES, { declareCycle: false }),
    cycle: wavetableWavByteLength(WAVETABLE_FRAME_SAMPLES, { declareCycle: false }),
    multisample: notes.length * wavetableWavByteLength(noteSamples, {
      declareCycle: false,
      channels: boreProfiles.right ? 2 : 1,
    }),
    sfz: textByteLength(boreExportSfz(stem)),
    metadata: documentByteLength(patchDocument()),
    relief: documentByteLength(reliefDocument()),
  };
}

function formatBytes(bytes) {
  if (bytes >= 1_000_000) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${Math.round(bytes / 1_024)} KB`;
}

function updateExportSummary() {
  const sizes = exportItemSizes();
  for (const [key, bytes] of Object.entries(sizes)) {
    requiredElement(`#export-size-${key}`, HTMLElement).textContent = formatBytes(bytes);
  }
  elements.exportParamsMultisample.textContent = `${boreExportNotes().length} NOTES · ${boreProfiles.right ? "STEREO" : "MONO"}`;
  const selected = exportSelection();
  const total = [...selected].reduce((sum, key) => sum + sizes[key], 0);
  elements.exportSummary.textContent = selected.size
    ? `${selected.size} ${selected.size === 1 ? "FILE" : "FILES"} · ${formatBytes(total)}${selected.size > 1 ? " · ZIP" : ""}`
    : "";
  elements.exportSubmit.disabled = selected.size === 0;
}

function bankFile(stem, frameSamples, declareCycle, suffix) {
  const parameters = currentWavetableParameters();
  const frames = buildWavetableFrames(terrain, parameters, {
    frames: EXPORT_FRAME_COUNT,
    frameSamples,
    fitToPeak: !parameters.normalize,
  });
  return {
    name: `${stem}-${suffix}.wav`,
    blob: encodeWavetableWav(frames, AUDIO_SAMPLE_RATE, { cycleSamples: frameSamples, declareCycle }),
  };
}

function cycleFile(stem) {
  const parameters = currentWavetableParameters();
  const samples = buildWavetableFrames(terrain, parameters, {
    frames: 1,
    frameSamples: WAVETABLE_FRAME_SAMPLES,
    fitToPeak: !parameters.normalize,
  });
  return {
    name: `${stem}-cycle.wav`,
    blob: encodeWavetableWav(samples, AUDIO_SAMPLE_RATE, { declareCycle: false }),
  };
}

function documentFile(name, patch) {
  return {
    name,
    blob: new Blob([`${JSON.stringify(patch, null, 2)}\n`], { type: "application/json" }),
  };
}

async function multisampleFiles(stem) {
  const notes = boreExportNotes();
  const fileNames = boreExportFileNames(stem, notes);
  const renders = await renderBoreMultisample(boreProfiles, notes, currentBoreParameters(), {
    sampleRate: AUDIO_SAMPLE_RATE,
    attackSeconds: Number(elements.attack.value),
    releaseSeconds: Number(elements.release.value),
  });
  return renders.map((render, index) => ({
    name: fileNames[index],
    blob: encodeNoteWav(render.channels, AUDIO_SAMPLE_RATE),
  }));
}

function sfzFile(stem) {
  return {
    name: `${stem}.sfz`,
    blob: new Blob([boreExportSfz(stem)], { type: "text/plain" }),
  };
}

async function buildExportFiles(selected, stem) {
  const files = [];
  if (selected.has("serum")) files.push(bankFile(stem, WAVETABLE_FRAME_SAMPLES, true, "serum"));
  if (selected.has("ableton")) files.push(bankFile(stem, ABLETON_FRAME_SAMPLES, false, "ableton"));
  if (selected.has("cycle")) files.push(cycleFile(stem));
  if (selected.has("multisample")) files.push(...await multisampleFiles(stem));
  if (selected.has("sfz")) files.push(sfzFile(stem));
  if (selected.has("metadata")) files.push(documentFile(`${stem}.geoflute.json`, patchDocument()));
  if (selected.has("relief")) files.push(documentFile(`${stem}.geoflute-relief.json`, reliefDocument()));
  return files;
}

elements.openExport.addEventListener("click", () => {
  if (!terrain || !wavetable) return;
  elements.exportError.hidden = true;
  updateExportSummary();
  elements.exportDialog.showModal();
  elements.exportDialog.focus({ preventScroll: true });
});

elements.exportForm.addEventListener("change", updateExportSummary);

elements.exportForm.addEventListener("submit", async (event) => {
  if (event.submitter instanceof HTMLButtonElement && event.submitter.value === "cancel") return;
  event.preventDefault();
  const selected = exportSelection();
  if (!selected.size || !terrain || !wavetable) return;
  elements.exportSubmit.disabled = true;
  elements.exportError.hidden = true;
  elements.audioStatus.textContent = "RENDERING EXPORT…";
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try {
    const stem = patchFileStem();
    const files = await buildExportFiles(selected, stem);
    if (files.length === 1) downloadBlob(files[0].blob, files[0].name);
    else {
      const entries = await Promise.all(files.map(async (file) => ({
        name: file.name,
        data: new Uint8Array(await file.blob.arrayBuffer()),
      })));
      downloadBlob(new Blob([zipStore(entries)], { type: "application/zip" }), `${stem}-export.zip`);
    }
    elements.audioStatus.textContent = `${files.length} ${files.length === 1 ? "FILE" : "FILES"} EXPORTED`;
    elements.exportDialog.close("export");
  } catch (error) {
    elements.exportError.textContent = error instanceof Error ? error.message.toUpperCase() : "EXPORT ERROR";
    elements.exportError.hidden = false;
    elements.audioStatus.textContent = "EXPORT FAILED";
  } finally {
    elements.exportSubmit.disabled = false;
  }
});

const visualResizeObserver = new ResizeObserver(() => {
  if (!drawnWavetable || !profileBank) return;
  drawWavetable(elements.wavetableCanvas, drawnWavetable, profileBank);
});
visualResizeObserver.observe(elements.wavetableCanvas);

root.addEventListener("input", (event) => {
  if (event.target === elements.searchQuery) return;
  scheduleSessionSave();
});
root.addEventListener("change", scheduleSessionSave);
window.addEventListener("pagehide", saveSession);

updateOctaveDisplay();
if (!restoreSession()) rebuildGeometry();
