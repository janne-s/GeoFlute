/**
 * @typedef {object} TerrainGrid
 * @property {number} size
 * @property {number} widthMeters
 * @property {number} heightMeters
 * @property {Float32Array} elevationMeters
 * @property {string} provider
 * @property {number} resolutionMeters
 * @property {number} minimumElevationMeters
 * @property {number} maximumElevationMeters
 */

/**
 * @typedef {object} ComplexGrid
 * @property {number} size
 * @property {Float64Array} real
 * @property {Float64Array} imaginary
 */

/**
 * @typedef {object} TerrainWavetable
 * @property {Float32Array} waveform
 * @property {Float32Array} real
 * @property {Float32Array} imaginary
 * @property {Float32Array} elevationMeters
 * @property {Float32Array} detrendedMeters
 * @property {{ start: { eastMeters: number, northMeters: number }, end: { eastMeters: number, northMeters: number }, bearingDeg: number, position: number, lengthMeters: number }} transect
 * @property {number} minimumElevationMeters
 * @property {number} maximumElevationMeters
 * @property {number} maximumHarmonic
 * @property {boolean} isFlat
 * @property {string} mapping
 * @property {string} seamMethod
 * @property {boolean} normalized
 */

export {};
