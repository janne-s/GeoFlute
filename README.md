# GeoFlute

GeoFlute is a browser-based terrain wavetable instrument. It converts a
directed elevation transect across a selected map area into a playable,
band-limited oscillator cycle.

Geometry determines timbre and pointer/computer-keyboard notes determine pitch.
The mapping is musical and experimental: it is not the environmental sound of
the selected place, nor a claimed natural frequency of it.

The cycle can be built two ways. `MIRROR` reflects the profile into a symmetric
cycle. `DIRECT` plays the transect once as it is, so the waveform follows the
relief itself. Amplitude is either normalized to a consistent working level or,
with `NORM` off, scaled by the actual relief so a low hill stays quieter than a
mountain.

The application runs entirely in the browser as native JavaScript modules and
is designed for direct static GitHub Pages deployment. It has no package
dependencies or required build step.

The interactive base map loads only the OpenStreetMap tiles visible in the
current viewport and displays the required OpenStreetMap attribution. Terrain
elevation is fetched from Mapzen Terrain Tiles in the AWS Registry of Open Data
and decoded locally. Terrain and audio calculations remain local to the browser.

## Playing

1. Select or move a map area with `AREA` and wait for the DEM status to be ready.
2. Set transect direction and bank position under the map, and the harmonic
   limit under `CYCLE`.
3. Play the on-screen notes or the `A W S E D F T G Y H U J K` keys. `Z` and `X`
   or the arrows under the keyboard shift the octave, and anything sounding
   glides with them. `PLAY`, or `SPACE`, sustains a note while you reshape the
   cycle; press either again to release it.
4. `SCAN` sweeps the transect across the area, morphing a held note as it moves.
5. `EXPORT` opens the package: two wavetable banks, one 2048-sample cycle with
   a `clm ` chunk for Serum, Vital and Bitwig and one 1024-sample cycle without
   a header for Ableton, plus an optional single cycle, the metadata document,
   and the transect relief as 64 elevations. Each is mono 16-bit, 256 frames
   written end to end. One selection downloads on its own, several arrive as a
   ZIP.

The area, map view, and every cycle, scan and envelope setting are kept in the
browser and restored the next time the page opens; nothing has to be saved for
that. `SAVE` and `OPEN` are for moving a session somewhere else: to another
browser or machine, to a colleague, or into more than one file. `OPEN` replaces
the current session, which is then kept by the browser as usual.

The saved file and the `METADATA` item in the export package are the same
document, so `OPEN` accepts either.

Turn `NORM` off before exporting if you want the terrain's own relief in the
file: frame amplitude then follows the transect instead of being levelled, and
the bank is scaled as a whole so the steepest frame reaches full scale. In
Ableton, enable `Raw` on import — without it Wavetable normalizes every frame
and fades the edges, which removes exactly that relief.

The `i` button next to the map zoom controls opens provenance, DEM source, and
attribution details.

## Development

Serve the repository root with any local static server, for example Python:

```sh
python3 -m http.server 4600
```

Then open `http://127.0.0.1:4600/`.

The model tests use the test runner built into current Node.js releases. No
packages need to be installed:

```sh
npm test
```

Module URLs carry the release version (`./audio/wav.js?v=0.3.0`) so a deploy
cannot serve a stale module beside a fresh one. Raise `version` in
`package.json` for a release and restamp every URL:

```sh
grep -rlE '\?v=[0-9.]+' src tests index.html | xargs sed -i '' 's/?v=0\.3\.0/?v=0.4.0/g'
```

`npm test` fails if any URL, or the version reported in exported documents,
disagrees with `package.json`.

The physically informed infrasound path that GeoFlute used to carry alongside
the instrument now lives in its own project and is not maintained here.
