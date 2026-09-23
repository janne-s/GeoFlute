import { createMulberry32 } from "./prng.js?v=0.4.1";

export const FOUNDATION_GRID_SIZE = 64;
export const FOUNDATION_EXTENT_METERS = 20_000;
export const FOUNDATION_SEED = 0x47554c46;
const EARTH_RADIUS_METERS = 6_371_008.8;
export const MINIMUM_EXTENT_METERS = 500;

/** @param {{ west: number, south: number, east: number, north: number }} bounds */
export function areaDimensions(bounds) {
  const middleLatitudeRadians = ((bounds.north + bounds.south) * Math.PI) / 360;
  const width = EARTH_RADIUS_METERS * Math.cos(middleLatitudeRadians) * ((bounds.east - bounds.west) * Math.PI) / 180;
  const height = EARTH_RADIUS_METERS * ((bounds.north - bounds.south) * Math.PI) / 180;
  return { widthMeters: Math.abs(width), heightMeters: Math.abs(height) };
}

/** @param {{ west: number, south: number, east: number, north: number }} bounds */
export function analysisExtent(bounds) {
  const dimensions = areaDimensions(bounds);
  return {
    widthMeters: Math.max(MINIMUM_EXTENT_METERS, dimensions.widthMeters),
    heightMeters: Math.max(MINIMUM_EXTENT_METERS, dimensions.heightMeters),
  };
}

/**
 * Deterministic volcanic massif used until a redistributable DEM is selected.
 * The anisotropic ridges intentionally make wind-direction tests meaningful.
 * @param {{ size?: number, widthMeters?: number, heightMeters?: number, extentMeters?: number, seed?: number }} [options]
 * @returns {import("./types.js").TerrainGrid}
 */
export function createFoundationTerrain(options = {}) {
  const size = options.size ?? FOUNDATION_GRID_SIZE;
  const widthMeters = options.widthMeters ?? options.extentMeters ?? FOUNDATION_EXTENT_METERS;
  const heightMeters = options.heightMeters ?? options.extentMeters ?? FOUNDATION_EXTENT_METERS;
  const seed = options.seed ?? FOUNDATION_SEED;
  const elevationMeters = new Float32Array(size * size);
  const random = createMulberry32(seed);

  for (let y = 0; y < size; y += 1) {
    const north = (y / (size - 1)) * 2 - 1;
    for (let x = 0; x < size; x += 1) {
      const east = (x / (size - 1)) * 2 - 1;
      const rotatedX = east * 0.82 + north * 0.57;
      const rotatedY = -east * 0.57 + north * 0.82;
      const massif = 1_250 * Math.exp(-3.4 * (east * east + north * north));
      const summit = 720 * Math.exp(-28 * ((east + 0.12) ** 2 + (north - 0.08) ** 2));
      const ridgeEnvelope = Math.exp(-2.8 * (rotatedX * rotatedX + rotatedY * rotatedY));
      const ridges = 155 * Math.sin(rotatedX * Math.PI * 7.5) * ridgeEnvelope;
      const fineRelief = (random.next() - 0.5) * 18 * ridgeEnvelope;
      elevationMeters[y * size + x] = Math.max(0, massif + summit + ridges + fineRelief);
    }
  }

  let maximumElevationMeters = 0;
  for (const elevation of elevationMeters) {
    maximumElevationMeters = Math.max(maximumElevationMeters, elevation);
  }
  return {
    size,
    widthMeters,
    heightMeters,
    elevationMeters,
    provider: "synthetic-fallback",
    resolutionMeters: Math.max(widthMeters, heightMeters) / size,
    minimumElevationMeters: 0,
    maximumElevationMeters,
  };
}

/** @returns {import("./types.js").TerrainGrid} */
export function createFlatTerrain(
  size = FOUNDATION_GRID_SIZE,
  widthMeters = FOUNDATION_EXTENT_METERS,
  heightMeters = widthMeters,
) {
  return {
    size,
    widthMeters,
    heightMeters,
    elevationMeters: new Float32Array(size * size),
    provider: "synthetic-test",
    resolutionMeters: Math.max(widthMeters, heightMeters) / size,
    minimumElevationMeters: 0,
    maximumElevationMeters: 0,
  };
}

/** @returns {import("./types.js").TerrainGrid} */
export function createSinusoidalRidge(size, widthMeters, cycles, amplitudeMeters = 1) {
  const elevationMeters = new Float32Array(size * size);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      elevationMeters[y * size + x] = amplitudeMeters * Math.sin((2 * Math.PI * cycles * x) / size);
    }
  }

  return {
    size,
    widthMeters,
    heightMeters: widthMeters,
    elevationMeters,
    provider: "synthetic-test",
    resolutionMeters: widthMeters / size,
    minimumElevationMeters: -amplitudeMeters,
    maximumElevationMeters: amplitudeMeters,
  };
}
