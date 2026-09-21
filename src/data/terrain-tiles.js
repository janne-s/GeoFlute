const TILE_SIZE = 256;
const MAX_LATITUDE = 85.05112878;
const MAX_ZOOM = 12;
const MIN_ZOOM = 1;
const MAX_TILE_REQUESTS = 16;
const EARTH_CIRCUMFERENCE_METERS = 40_075_016.686;
const PROVIDER_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function longitudeToTileX(longitude, zoom) {
  return ((longitude + 180) / 360) * 2 ** zoom;
}

function latitudeToTileY(latitude, zoom) {
  const radians = (clamp(latitude, -MAX_LATITUDE, MAX_LATITUDE) * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * 2 ** zoom;
}

function tileRange(bounds, zoom) {
  const maximumIndex = 2 ** zoom - 1;
  const west = clamp(Math.floor(longitudeToTileX(bounds.west, zoom)), 0, maximumIndex);
  const east = clamp(Math.floor(longitudeToTileX(bounds.east, zoom)), 0, maximumIndex);
  const north = clamp(Math.floor(latitudeToTileY(bounds.north, zoom)), 0, maximumIndex);
  const south = clamp(Math.floor(latitudeToTileY(bounds.south, zoom)), 0, maximumIndex);
  return {
    west,
    east,
    north,
    south,
    count: (east - west + 1) * (south - north + 1),
  };
}

function selectZoom(bounds) {
  for (let zoom = MAX_ZOOM; zoom >= MIN_ZOOM; zoom -= 1) {
    if (tileRange(bounds, zoom).count <= MAX_TILE_REQUESTS) return zoom;
  }
  return MIN_ZOOM;
}

async function decodeTile(response) {
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("DEM tile canvas is unavailable");
  context.drawImage(bitmap, 0, 0, TILE_SIZE, TILE_SIZE);
  bitmap.close();
  return context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
}

function decodeTerrarium(data, pixelX, pixelY) {
  const offset = (pixelY * TILE_SIZE + pixelX) * 4;
  return data[offset] * 256 + data[offset + 1] + data[offset + 2] / 256 - 32_768;
}

/**
 * Fetches only the tiles intersecting the selected region and resamples them
 * to the analysis grid. Terrain Tiles encodes metres in Terrarium RGB format.
 * @param {{ west: number, south: number, east: number, north: number }} bounds
 * @param {{ size: number, widthMeters: number, heightMeters: number, signal?: AbortSignal }} options
 * @returns {Promise<import("../model/types.js").TerrainGrid & { zoom: number, tileCount: number, imagerySources: string[] }>}
 */
export async function loadTerrainGrid(bounds, options) {
  if (bounds.east <= bounds.west || bounds.north <= bounds.south) {
    throw new RangeError("Selected terrain bounds are empty");
  }

  const zoom = selectZoom(bounds);
  const range = tileRange(bounds, zoom);
  const tileEntries = [];
  for (let tileY = range.north; tileY <= range.south; tileY += 1) {
    for (let tileX = range.west; tileX <= range.east; tileX += 1) {
      tileEntries.push({ tileX, tileY });
    }
  }

  const imagerySources = new Set();
  const decodedTiles = new Map();
  await Promise.all(tileEntries.map(async ({ tileX, tileY }) => {
    const response = await fetch(`${PROVIDER_URL}/${zoom}/${tileX}/${tileY}.png`, {
      mode: "cors",
      cache: "force-cache",
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(`DEM tile ${zoom}/${tileX}/${tileY} returned ${response.status}`);
    }
    const sourceHeader = response.headers.get("x-amz-meta-x-imagery-sources");
    if (sourceHeader) {
      for (const source of sourceHeader.split(",")) imagerySources.add(source.trim());
    }
    decodedTiles.set(`${tileX}/${tileY}`, await decodeTile(response));
  }));

  const elevationMeters = new Float32Array(options.size * options.size);
  let minimumElevationMeters = Number.POSITIVE_INFINITY;
  let maximumElevationMeters = Number.NEGATIVE_INFINITY;

  for (let gridY = 0; gridY < options.size; gridY += 1) {
    const latitude = bounds.north
      - (gridY / (options.size - 1)) * (bounds.north - bounds.south);
    const worldPixelY = latitudeToTileY(latitude, zoom) * TILE_SIZE;
    const tileY = clamp(Math.floor(worldPixelY / TILE_SIZE), range.north, range.south);
    const pixelY = clamp(Math.floor(worldPixelY - tileY * TILE_SIZE), 0, TILE_SIZE - 1);

    for (let gridX = 0; gridX < options.size; gridX += 1) {
      const longitude = bounds.west
        + (gridX / (options.size - 1)) * (bounds.east - bounds.west);
      const worldPixelX = longitudeToTileX(longitude, zoom) * TILE_SIZE;
      const tileX = clamp(Math.floor(worldPixelX / TILE_SIZE), range.west, range.east);
      const pixelX = clamp(Math.floor(worldPixelX - tileX * TILE_SIZE), 0, TILE_SIZE - 1);
      const tile = decodedTiles.get(`${tileX}/${tileY}`);
      if (!tile) throw new Error("A required DEM tile is missing after loading");
      const elevation = decodeTerrarium(tile, pixelX, pixelY);
      elevationMeters[gridY * options.size + gridX] = elevation;
      minimumElevationMeters = Math.min(minimumElevationMeters, elevation);
      maximumElevationMeters = Math.max(maximumElevationMeters, elevation);
    }
  }

  const middleLatitudeRadians = ((bounds.north + bounds.south) * Math.PI) / 360;
  const nativeResolutionMeters = (
    Math.cos(middleLatitudeRadians) * EARTH_CIRCUMFERENCE_METERS
  ) / (TILE_SIZE * 2 ** zoom);

  return {
    size: options.size,
    widthMeters: options.widthMeters,
    heightMeters: options.heightMeters,
    elevationMeters,
    provider: "mapzen-terrain-tiles-aws",
    resolutionMeters: nativeResolutionMeters,
    minimumElevationMeters,
    maximumElevationMeters,
    zoom,
    tileCount: tileEntries.length,
    imagerySources: [...imagerySources],
  };
}
