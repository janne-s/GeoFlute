const TILE_SIZE = 256;
const MAX_MERCATOR_LAT = 85.05112878;
const MIN_ZOOM = 1;
const MAX_ZOOM = 14;
const HANDLE_HIT_RADIUS = 14;
const PINCH_ZOOM_SENSITIVITY = 0.01;
const WHEEL_ZOOM_SENSITIVITY = 0.006;
const MAX_ZOOM_PER_EVENT = 0.5;
const TILE_OVERLAP = 1.002;

export const MAP_PROVIDERS = {
  relief: {
    id: "relief",
    tileUrl(zoom, x, y) {
      return `https://tile.opentopomap.org/${zoom}/${x}/${y}.png`;
    },
  },
  map: {
    id: "map",
    tileUrl(zoom, x, y) {
      return `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
    },
  },
};

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function wrapLongitude(longitude) {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

function project(longitude, latitude, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const clampedLatitude = clamp(latitude, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT);
  const latitudeRadians = (clampedLatitude * Math.PI) / 180;
  return {
    x: ((longitude + 180) / 360) * scale,
    y: (1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) * 0.5 * scale,
  };
}

function unproject(x, y, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const longitude = (x / scale) * 360 - 180;
  const mercatorY = Math.PI * (1 - (2 * y) / scale);
  const latitude = (Math.atan(Math.sinh(mercatorY)) * 180) / Math.PI;
  return {
    longitude: wrapLongitude(longitude),
    latitude: clamp(latitude, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT),
  };
}

function normalizedBounds(first, second) {
  return {
    west: Math.min(first.longitude, second.longitude),
    south: Math.min(first.latitude, second.latitude),
    east: Math.max(first.longitude, second.longitude),
    north: Math.max(first.latitude, second.latitude),
  };
}

function containsPosition(bounds, position) {
  return position.longitude >= bounds.west
    && position.longitude <= bounds.east
    && position.latitude >= bounds.south
    && position.latitude <= bounds.north;
}

function movedBounds(bounds, deltaLongitude, deltaLatitude) {
  let west = bounds.west + deltaLongitude;
  let east = bounds.east + deltaLongitude;
  let south = bounds.south + deltaLatitude;
  let north = bounds.north + deltaLatitude;

  if (west < -180) {
    east += -180 - west;
    west = -180;
  } else if (east > 180) {
    west -= east - 180;
    east = 180;
  }
  if (south < -MAX_MERCATOR_LAT) {
    north += -MAX_MERCATOR_LAT - south;
    south = -MAX_MERCATOR_LAT;
  } else if (north > MAX_MERCATOR_LAT) {
    south -= north - MAX_MERCATOR_LAT;
    north = MAX_MERCATOR_LAT;
  }
  return { west, south, east, north };
}

export class WorldMap {
  constructor(container, options) {
    this.container = container;
    this.center = { ...options.center };
    this.zoom = clamp(options.zoom, MIN_ZOOM, MAX_ZOOM);
    this.provider = MAP_PROVIDERS[options.provider ?? "relief"];
    this.selection = options.selection ?? null;
    this.transect = null;
    this.onSelection = options.onSelection;
    this.onDrawArmedChange = options.onDrawArmedChange;
    this.drawArmed = false;
    this.tiles = new Map();
    this.drag = null;
    this.selectionDraft = null;

    this.tileLayer = document.createElement("div");
    this.tileLayer.className = "map-tiles";
    this.selectionElement = document.createElement("div");
    this.selectionElement.className = "map-selection";
    this.terrainOverlay = document.createElement("canvas");
    this.terrainOverlay.className = "map-terrain-overlay";
    this.transectElement = document.createElement("div");
    this.transectElement.className = "map-transect";
    this.transectElement.setAttribute("aria-hidden", "true");
    this.handleElements = ["nw", "se"].map((corner) => {
      const handle = document.createElement("div");
      handle.className = `map-handle map-handle-${corner}`;
      handle.setAttribute("aria-hidden", "true");
      return handle;
    });

    container.replaceChildren(
      this.tileLayer,
      this.terrainOverlay,
      this.selectionElement,
      this.transectElement,
      ...this.handleElements,
    );
    container.tabIndex = 0;
    container.addEventListener("pointerdown", (event) => this.handlePointerDown(event));
    container.addEventListener("pointermove", (event) => this.handlePointerMove(event));
    container.addEventListener("pointerup", (event) => this.handlePointerUp(event));
    container.addEventListener("pointercancel", () => this.cancelInteraction());
    container.addEventListener("wheel", (event) => this.handleWheel(event), { passive: false });
    container.addEventListener("keydown", (event) => this.handleKeyDown(event));

    this.resizeObserver = new ResizeObserver(() => this.render());
    this.resizeObserver.observe(container);
    this.render();
  }

  armDraw(armed = true) {
    this.drawArmed = armed;
    this.container.dataset.draw = armed ? "armed" : "";
    this.onDrawArmedChange?.(armed);
  }

  setSelection(bounds) {
    this.selection = bounds;
    this.updateOverlays();
  }

  setTransect(transect) {
    this.transect = transect;
    this.updateOverlays();
  }

  setProvider(providerId) {
    const provider = MAP_PROVIDERS[providerId];
    if (!provider || provider === this.provider) return;
    this.provider = provider;
    for (const image of this.tiles.values()) image.remove();
    this.tiles.clear();
    this.render();
  }

  setTerrainOverlay(terrain) {
    if (!terrain) {
      this.terrainOverlay.hidden = true;
      return;
    }
    const { size, elevationMeters } = terrain;
    this.terrainOverlay.width = size;
    this.terrainOverlay.height = size;
    const context = this.terrainOverlay.getContext("2d");
    if (!context) throw new Error("Terrain overlay canvas is unavailable");
    const image = context.createImageData(size, size);
    const cellX = terrain.widthMeters / Math.max(1, size - 1);
    const cellY = terrain.heightMeters / Math.max(1, size - 1);
    const sun = { x: -0.55, y: -0.55, z: 0.63 };

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const left = elevationMeters[y * size + Math.max(0, x - 1)];
        const right = elevationMeters[y * size + Math.min(size - 1, x + 1)];
        const up = elevationMeters[Math.max(0, y - 1) * size + x];
        const down = elevationMeters[Math.min(size - 1, y + 1) * size + x];
        const slopeX = (right - left) / (2 * cellX);
        const slopeY = (down - up) / (2 * cellY);
        const length = Math.hypot(slopeX, slopeY, 1);
        const light = Math.max(0, (-slopeX * sun.x - slopeY * sun.y + sun.z) / length);
        const value = Math.round(32 + light * 205);
        const offset = (y * size + x) * 4;
        image.data[offset] = value;
        image.data[offset + 1] = value;
        image.data[offset + 2] = value;
        image.data[offset + 3] = 230;
      }
    }
    context.putImageData(image, 0, 0);
    this.terrainOverlay.hidden = false;
    this.updateOverlays();
  }

  viewState() {
    return { longitude: this.center.longitude, latitude: this.center.latitude, zoom: this.zoom };
  }

  setView(center, zoom) {
    this.center = { ...center };
    this.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    this.render();
  }

  zoomBy(delta, anchorX = this.container.clientWidth / 2, anchorY = this.container.clientHeight / 2) {
    this.zoomTo(this.zoom + delta, anchorX, anchorY);
  }

  zoomStep(direction, anchorX = this.container.clientWidth / 2, anchorY = this.container.clientHeight / 2) {
    this.zoomTo(Math.round(this.zoom) + direction, anchorX, anchorY);
  }

  zoomTo(zoom, anchorX = this.container.clientWidth / 2, anchorY = this.container.clientHeight / 2) {
    const nextZoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    if (nextZoom === this.zoom) return;

    const anchorGeo = this.screenToGeo(anchorX, anchorY);
    this.zoom = nextZoom;
    const anchorWorld = project(anchorGeo.longitude, anchorGeo.latitude, this.zoom);
    const centerWorld = {
      x: anchorWorld.x - (anchorX - this.container.clientWidth / 2),
      y: anchorWorld.y - (anchorY - this.container.clientHeight / 2),
    };
    this.center = unproject(centerWorld.x, centerWorld.y, this.zoom);
    this.render();
  }

  screenToGeo(screenX, screenY) {
    const centerWorld = project(this.center.longitude, this.center.latitude, this.zoom);
    return unproject(
      centerWorld.x + screenX - this.container.clientWidth / 2,
      centerWorld.y + screenY - this.container.clientHeight / 2,
      this.zoom,
    );
  }

  geoToScreen(position) {
    const centerWorld = project(this.center.longitude, this.center.latitude, this.zoom);
    const world = project(position.longitude, position.latitude, this.zoom);
    let deltaX = world.x - centerWorld.x;
    const worldWidth = TILE_SIZE * 2 ** this.zoom;
    if (deltaX > worldWidth / 2) deltaX -= worldWidth;
    if (deltaX < -worldWidth / 2) deltaX += worldWidth;
    return {
      x: this.container.clientWidth / 2 + deltaX,
      y: this.container.clientHeight / 2 + world.y - centerWorld.y,
    };
  }

  handleAt(point) {
    if (!this.selection) return null;
    const corners = {
      nw: this.geoToScreen({ longitude: this.selection.west, latitude: this.selection.north }),
      se: this.geoToScreen({ longitude: this.selection.east, latitude: this.selection.south }),
    };
    for (const [corner, position] of Object.entries(corners)) {
      if (Math.hypot(point.x - position.x, point.y - position.y) <= HANDLE_HIT_RADIUS) {
        return corner;
      }
    }
    return null;
  }

  intentAt(point) {
    const corner = this.handleAt(point);
    if (corner) return corner === "nw" ? "resize-nw" : "resize-se";
    if (this.drawArmed) return "draw";
    if (this.selection && containsPosition(this.selection, this.screenToGeo(point.x, point.y))) {
      return "move";
    }
    return "pan";
  }

  handlePointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    this.container.setPointerCapture(event.pointerId);
    const rect = this.container.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const startGeo = this.screenToGeo(point.x, point.y);
    const intent = this.intentAt(point);

    document.body.classList.add("is-map-dragging");
    this.drag = { pointerId: event.pointerId, start: point, startGeo, intent };

    if (intent === "pan") {
      this.drag.centerWorld = project(this.center.longitude, this.center.latitude, this.zoom);
      this.container.classList.add("is-dragging");
      return;
    }

    if (intent === "move") {
      this.drag.initialSelection = { ...this.selection };
      this.selectionDraft = { ...this.selection };
    } else if (intent === "draw") {
      this.selectionDraft = normalizedBounds(startGeo, startGeo);
    } else {
      this.drag.anchorGeo = intent === "resize-nw"
        ? { longitude: this.selection.east, latitude: this.selection.south }
        : { longitude: this.selection.west, latitude: this.selection.north };
      this.selectionDraft = { ...this.selection };
    }
    this.updateOverlays();
  }

  handlePointerMove(event) {
    const rect = this.container.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };

    if (!this.drag || this.drag.pointerId !== event.pointerId) {
      this.container.dataset.intent = this.intentAt(point);
      return;
    }

    const geo = this.screenToGeo(point.x, point.y);
    if (this.drag.intent === "pan") {
      this.center = unproject(
        this.drag.centerWorld.x - (point.x - this.drag.start.x),
        this.drag.centerWorld.y - (point.y - this.drag.start.y),
        this.zoom,
      );
      this.render();
      return;
    }

    if (this.drag.intent === "move") {
      this.selectionDraft = movedBounds(
        this.drag.initialSelection,
        geo.longitude - this.drag.startGeo.longitude,
        geo.latitude - this.drag.startGeo.latitude,
      );
    } else if (this.drag.intent === "draw") {
      this.selectionDraft = normalizedBounds(this.drag.startGeo, geo);
    } else {
      this.selectionDraft = normalizedBounds(this.drag.anchorGeo, geo);
    }
    this.updateOverlays();
  }

  handlePointerUp(event) {
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    const rect = this.container.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const movement = Math.hypot(point.x - this.drag.start.x, point.y - this.drag.start.y);
    const { intent } = this.drag;

    if (intent !== "pan" && this.selectionDraft && movement >= (intent === "draw" ? 6 : 2)) {
      this.selection = this.selectionDraft;
      this.onSelection?.(this.selection);
    }
    if (intent === "draw") this.armDraw(false);

    this.selectionDraft = null;
    this.drag = null;
    document.body.classList.remove("is-map-dragging");
    this.container.classList.remove("is-dragging");
    this.updateOverlays();
  }

  handleWheel(event) {
    event.preventDefault();
    const rect = this.container.getBoundingClientRect();
    const lineHeight = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.container.clientHeight : 1;
    const sensitivity = event.ctrlKey ? PINCH_ZOOM_SENSITIVITY : WHEEL_ZOOM_SENSITIVITY;
    const delta = clamp(
      -event.deltaY * lineHeight * sensitivity,
      -MAX_ZOOM_PER_EVENT,
      MAX_ZOOM_PER_EVENT,
    );
    this.zoomBy(delta, event.clientX - rect.left, event.clientY - rect.top);
  }

  handleKeyDown(event) {
    const step = 80;
    const centerWorld = project(this.center.longitude, this.center.latitude, this.zoom);
    if (event.key === "+" || event.key === "=") this.zoomStep(1);
    else if (event.key === "-") this.zoomStep(-1);
    else if (event.key === "ArrowLeft") this.center = unproject(centerWorld.x - step, centerWorld.y, this.zoom);
    else if (event.key === "ArrowRight") this.center = unproject(centerWorld.x + step, centerWorld.y, this.zoom);
    else if (event.key === "ArrowUp") this.center = unproject(centerWorld.x, centerWorld.y - step, this.zoom);
    else if (event.key === "ArrowDown") this.center = unproject(centerWorld.x, centerWorld.y + step, this.zoom);
    else return;
    event.preventDefault();
    this.render();
  }

  cancelInteraction() {
    this.drag = null;
    this.selectionDraft = null;
    document.body.classList.remove("is-map-dragging");
    this.container.classList.remove("is-dragging");
    this.updateOverlays();
  }

  render() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;

    const tileZoom = Math.round(this.zoom);
    const tileScale = 2 ** (this.zoom - tileZoom);
    const tileSpan = TILE_SIZE * tileScale;
    const centerWorld = project(this.center.longitude, this.center.latitude, this.zoom);
    const originX = centerWorld.x - width / 2;
    const originY = centerWorld.y - height / 2;
    const firstX = Math.floor(originX / tileSpan);
    const lastX = Math.floor((originX + width) / tileSpan);
    const firstY = Math.max(0, Math.floor(originY / tileSpan));
    const tileCount = 2 ** tileZoom;
    const lastY = Math.min(tileCount - 1, Math.floor((originY + height) / tileSpan));
    const required = new Set();

    for (let tileY = firstY; tileY <= lastY; tileY += 1) {
      for (let rawTileX = firstX; rawTileX <= lastX; rawTileX += 1) {
        const tileX = ((rawTileX % tileCount) + tileCount) % tileCount;
        const key = `${tileZoom}/${rawTileX}/${tileY}`;
        required.add(key);
        let image = this.tiles.get(key);
        if (!image) {
          image = new Image(TILE_SIZE, TILE_SIZE);
          image.alt = "";
          image.decoding = "async";
          image.draggable = false;
          image.src = this.provider.tileUrl(tileZoom, tileX, tileY);
          this.tiles.set(key, image);
          this.tileLayer.append(image);
        }
        const x = rawTileX * tileSpan - originX;
        const y = tileY * tileSpan - originY;
        image.style.transform = `translate(${x}px, ${y}px) scale(${tileScale * TILE_OVERLAP})`;
      }
    }

    for (const [key, image] of this.tiles) {
      if (!required.has(key)) {
        image.remove();
        this.tiles.delete(key);
      }
    }
    this.updateOverlays();
  }

  updateOverlays() {
    const bounds = this.selectionDraft ?? this.selection;
    if (bounds) {
      const northWest = this.geoToScreen({ longitude: bounds.west, latitude: bounds.north });
      const southEast = this.geoToScreen({ longitude: bounds.east, latitude: bounds.south });
      this.selectionElement.hidden = false;
      this.selectionElement.style.left = `${Math.min(northWest.x, southEast.x)}px`;
      this.selectionElement.style.top = `${Math.min(northWest.y, southEast.y)}px`;
      this.selectionElement.style.width = `${Math.abs(southEast.x - northWest.x)}px`;
      this.selectionElement.style.height = `${Math.abs(southEast.y - northWest.y)}px`;
      this.terrainOverlay.style.left = `${Math.min(northWest.x, southEast.x)}px`;
      this.terrainOverlay.style.top = `${Math.min(northWest.y, southEast.y)}px`;
      this.terrainOverlay.style.width = `${Math.abs(southEast.x - northWest.x)}px`;
      this.terrainOverlay.style.height = `${Math.abs(southEast.y - northWest.y)}px`;
      for (const [index, corner] of [northWest, southEast].entries()) {
        const handle = this.handleElements[index];
        handle.hidden = false;
        handle.style.transform = `translate(${corner.x}px, ${corner.y}px)`;
      }
    } else {
      this.selectionElement.hidden = true;
      for (const handle of this.handleElements) handle.hidden = true;
    }

    if (this.transect) {
      const start = this.geoToScreen(this.transect.start);
      const end = this.geoToScreen(this.transect.end);
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      const angle = Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI;
      this.transectElement.hidden = false;
      this.transectElement.style.left = `${start.x}px`;
      this.transectElement.style.top = `${start.y}px`;
      this.transectElement.style.width = `${length}px`;
      this.transectElement.style.transform = `rotate(${angle}deg)`;
    } else {
      this.transectElement.hidden = true;
    }
  }
}
