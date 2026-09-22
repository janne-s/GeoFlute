const palette = getComputedStyle(document.documentElement);
const token = (name, fallback) => palette.getPropertyValue(name).trim() || fallback;
const BACKGROUND = token("--surface", "#101010");
const ACCENT = token("--accent", "#a795fe");
const MUTED = token("--muted", "#858585");
const LINE = token("--line", "#363636");
const OUTLINE = "rgb(0 0 0 / 65%)";
const MINIMUM_DRAWABLE_SIZE = 24;
const LABEL_FONT = "10px monospace";
const LABEL_INSET = 9;
const LABEL_BASELINE = 15;

function prepareCanvas(canvas, size) {
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable");
  context.imageSmoothingEnabled = false;
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, size, size);
  return context;
}

/** @param {HTMLCanvasElement} canvas @param {import("../model/types.js").TerrainGrid} terrain @param {import("../model/types.js").TerrainWavetable["transect"] | null} [transect] */
export function drawTerrain(canvas, terrain, transect = null) {
  const context = prepareCanvas(canvas, terrain.size);
  const image = context.createImageData(terrain.size, terrain.size);
  const minimum = terrain.minimumElevationMeters;
  const maximum = terrain.maximumElevationMeters;
  const range = Math.max(1, maximum - minimum);

  for (let index = 0; index < terrain.elevationMeters.length; index += 1) {
    const normalized = (terrain.elevationMeters[index] - minimum) / range;
    const value = Math.round(18 + Math.sqrt(Math.max(0, normalized)) * 220);
    const offset = index * 4;
    image.data[offset] = value;
    image.data[offset + 1] = value;
    image.data[offset + 2] = value;
    image.data[offset + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  if (transect) {
    const toCanvas = (point) => ({
      x: ((point.eastMeters / terrain.widthMeters) + 0.5) * terrain.size,
      y: (0.5 - point.northMeters / terrain.heightMeters) * terrain.size,
    });
    const start = toCanvas(transect.start);
    const end = toCanvas(transect.end);
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.strokeStyle = OUTLINE;
    context.lineWidth = 3.1;
    context.stroke();
    context.strokeStyle = ACCENT;
    context.lineWidth = 1.1;
    context.stroke();
    context.fillStyle = OUTLINE;
    context.fillRect(start.x - 2, start.y - 2, 5, 5);
    context.fillRect(end.x - 2, end.y - 2, 5, 5);
    context.fillStyle = ACCENT;
    context.fillRect(start.x - 1, start.y - 1, 3, 3);
    context.fillRect(end.x - 1, end.y - 1, 3, 3);
  }
}

function drawProfileStack(context, bank, activePosition, area) {
  const { left, right, top, bottom } = area;
  const skew = (right - left) * 0.14;
  const traceWidth = right - left - skew;
  const range = Math.max(1, bank.maximumElevationMeters - bank.minimumElevationMeters);
  const traceHeight = (bottom - top) * 0.42;
  const count = bank.profiles.length;
  const baselineSpan = bottom - top - traceHeight;
  let activeIndex = 0;

  for (let index = 1; index < count; index += 1) {
    const closer = Math.abs(bank.profiles[index].position - activePosition)
      < Math.abs(bank.profiles[activeIndex].position - activePosition);
    if (closer) activeIndex = index;
  }

  const traceGeometry = (index) => {
    const depth = index / (count - 1);
    return {
      depth,
      baseline: bottom - depth * baselineSpan,
      offsetX: left + depth * skew,
      elevationMeters: bank.profiles[index].elevationMeters,
    };
  };

  const tracePath = ({ baseline, offsetX, elevationMeters }) => {
    const points = elevationMeters.length;
    context.beginPath();
    for (let sample = 0; sample < points; sample += 1) {
      const normalized = (elevationMeters[sample] - bank.minimumElevationMeters) / range;
      const x = offsetX + (sample / (points - 1)) * traceWidth;
      const y = baseline - normalized * traceHeight;
      if (sample === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
  };

  for (let index = count - 1; index >= 0; index -= 1) {
    const geometry = traceGeometry(index);
    tracePath(geometry);
    context.lineTo(geometry.offsetX + traceWidth, geometry.baseline);
    context.lineTo(geometry.offsetX, geometry.baseline);
    context.closePath();
    context.fillStyle = BACKGROUND;
    context.fill();

    const shade = Math.round(112 - geometry.depth * 40);
    tracePath(geometry);
    context.strokeStyle = index === activeIndex
      ? ACCENT
      : `rgb(${shade} ${shade} ${shade})`;
    context.lineWidth = 1;
    context.stroke();
  }

  tracePath(traceGeometry(activeIndex));
  context.strokeStyle = ACCENT;
  context.lineWidth = 1.6;
  context.stroke();
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {import("../model/types.js").TerrainWavetable} wavetable
 * @param {{ profiles: Array<{ position: number, elevationMeters: Float32Array }>,
 *   minimumElevationMeters: number, maximumElevationMeters: number }} bank
 */
export function drawWavetable(canvas, wavetable, bank) {
  const width = Math.round(canvas.clientWidth);
  const height = Math.round(canvas.clientHeight);
  if (width < MINIMUM_DRAWABLE_SIZE || height < MINIMUM_DRAWABLE_SIZE) return;
  const pixelRatio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Wavetable canvas is unavailable");
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, width, height);
  context.font = LABEL_FONT;
  context.fillStyle = MUTED;
  const splitY = Math.round(height * 0.6);
  const cycleCenter = splitY + (height - splitY) / 2;
  const cycleAmplitude = (height - splitY) * 0.36;
  context.fillText("BANK", LABEL_INSET, LABEL_BASELINE);
  context.fillText("CYCLE", LABEL_INSET, splitY + LABEL_BASELINE);
  context.strokeStyle = LINE;
  context.beginPath();
  context.moveTo(0, splitY);
  context.lineTo(width, splitY);
  context.moveTo(0, cycleCenter);
  context.lineTo(width, cycleCenter);
  context.stroke();

  drawProfileStack(context, bank, wavetable.transect.position, {
    left: LABEL_INSET + 1,
    right: width - LABEL_INSET - 1,
    top: LABEL_BASELINE + 5,
    bottom: splitY - 10,
  });

  context.strokeStyle = ACCENT;
  context.lineWidth = 1.6;
  context.beginPath();
  for (let index = 0; index < wavetable.waveform.length; index += 1) {
    const x = (index / (wavetable.waveform.length - 1)) * (width - 1);
    const y = cycleCenter - wavetable.waveform[index] * cycleAmplitude;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.stroke();
}
