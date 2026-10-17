/** Input paths for the benchmark gestures, in CSS pixels of the page. */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where the engine draws the image, in device pixels of the canvas (the engine's `ViewLayout`). */
export interface ImageLayout {
  readonly zoom: number;
  readonly originX: number;
  readonly originY: number;
  readonly documentWidth: number;
  readonly documentHeight: number;
}

export interface StrokePath {
  /** The pointer-down point followed by one point per move. */
  readonly points: readonly Point[];
  /** The stroke's length in image pixels. */
  readonly imageLength: number;
}

/**
 * A straight stroke of `imageLength` image pixels, sent as `moves` evenly spaced moves. It runs
 * along the diagonal of the part of the image that is on screen, `margin` CSS pixels inside the
 * canvas (clear of the auto-scroll band), centered there. A stroke that does not fit is shortened
 * to the longest one that does, and `imageLength` reports what was used.
 */
export function strokePath(
  canvas: Box,
  layout: ImageLayout,
  devicePixelRatio: number,
  imageLength: number,
  moves: number,
  margin: number,
): StrokePath {
  const scale = layout.zoom / devicePixelRatio;
  const left = Math.max(canvas.x + margin, canvas.x + layout.originX / devicePixelRatio);
  const top = Math.max(canvas.y + margin, canvas.y + layout.originY / devicePixelRatio);
  const right = Math.min(
    canvas.x + canvas.width - margin,
    canvas.x + layout.originX / devicePixelRatio + layout.documentWidth * scale,
  );
  const bottom = Math.min(
    canvas.y + canvas.height - margin,
    canvas.y + layout.originY / devicePixelRatio + layout.documentHeight * scale,
  );
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  const diagonal = Math.hypot(width, height);
  const length = Math.min(imageLength * scale, diagonal);
  const dx = diagonal > 0 ? width / diagonal : 0;
  const dy = diagonal > 0 ? height / diagonal : 0;
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const points = Array.from({ length: moves + 1 }, (_, index) => {
    const along = (index / moves - 0.5) * length;
    return { x: cx + dx * along, y: cy + dy * along };
  });
  return { points, imageLength: length / scale };
}

/**
 * A spiral of `turns` turns around the center of the image, in CSS pixels of the page, sent as
 * `moves` evenly spaced moves. It grows from 10 % to 45 % of the image's smaller on-screen side.
 */
export function spiralPath(
  canvas: Box,
  layout: ImageLayout,
  devicePixelRatio: number,
  turns: number,
  moves: number,
): Point[] {
  const scale = layout.zoom / devicePixelRatio;
  const width = layout.documentWidth * scale;
  const height = layout.documentHeight * scale;
  const cx = canvas.x + layout.originX / devicePixelRatio + width / 2;
  const cy = canvas.y + layout.originY / devicePixelRatio + height / 2;
  const side = Math.min(width, height);
  return Array.from({ length: moves + 1 }, (_, index) => {
    const along = index / moves;
    const angle = 2 * Math.PI * turns * along;
    const radius = side * (0.1 + 0.35 * along);
    return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  });
}

/**
 * A closed figure-eight around `center` for a pan drag: `moves` moves, `radius` CSS pixels across
 * and half that up and down, ending where it started.
 */
export function panPath(center: Point, radius: number, moves: number): Point[] {
  return Array.from({ length: moves + 1 }, (_, index) => {
    const turn = (2 * Math.PI * index) / moves;
    return {
      x: center.x + radius * Math.sin(turn),
      y: center.y + (radius / 2) * Math.sin(2 * turn),
    };
  });
}

/** A drag along the middle of a slider track from `from` to `to` (fractions of its width). */
export function sliderPath(track: Box, from: number, to: number, moves: number): Point[] {
  const y = track.y + track.height / 2;
  return Array.from({ length: moves + 1 }, (_, index) => ({
    x: track.x + track.width * (from + ((to - from) * index) / moves),
    y,
  }));
}

/**
 * A drag back and forth along the middle of a slider track: `sweeps` full sweeps between the
 * fractions `low` and `high` of its width, starting at their midpoint, sent as `moves` moves.
 */
export function sliderSweepPath(
  track: Box,
  low: number,
  high: number,
  sweeps: number,
  moves: number,
): Point[] {
  const y = track.y + track.height / 2;
  const middle = (low + high) / 2;
  const half = (high - low) / 2;
  return Array.from({ length: moves + 1 }, (_, index) => ({
    x: track.x + track.width * (middle + half * Math.sin((Math.PI * sweeps * index) / moves)),
    y,
  }));
}

/**
 * `turns` circles of `radius` CSS pixels around `center`, sent as `moves` evenly spaced moves. It
 * starts and ends at the circle's rightmost point.
 */
export function circlePath(center: Point, radius: number, turns: number, moves: number): Point[] {
  return Array.from({ length: moves + 1 }, (_, index) => {
    const angle = (2 * Math.PI * turns * index) / moves;
    return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
  });
}

/** `count` evenly spaced points from `from` to `to`, after `from` itself. */
export function linePath(from: Point, to: Point, count: number): Point[] {
  return Array.from({ length: count }, (_, index) => {
    const t = (index + 1) / count;
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  });
}

/** The image pixel under a CSS point of the page. */
export function cssToImage(
  canvas: Box,
  layout: ImageLayout,
  devicePixelRatio: number,
  point: Point,
): Point {
  return {
    x: ((point.x - canvas.x) * devicePixelRatio - layout.originX) / layout.zoom,
    y: ((point.y - canvas.y) * devicePixelRatio - layout.originY) / layout.zoom,
  };
}

/** The CSS point of the page where an image point is shown. */
export function imageToCss(
  canvas: Box,
  layout: ImageLayout,
  devicePixelRatio: number,
  point: Point,
): Point {
  return {
    x: canvas.x + (layout.originX + point.x * layout.zoom) / devicePixelRatio,
    y: canvas.y + (layout.originY + point.y * layout.zoom) / devicePixelRatio,
  };
}

/** The image's on-screen rectangle in CSS pixels of the page, clipped to the canvas. */
export function visibleImage(canvas: Box, layout: ImageLayout, devicePixelRatio: number): Box {
  const scale = layout.zoom / devicePixelRatio;
  const left = Math.max(canvas.x, canvas.x + layout.originX / devicePixelRatio);
  const top = Math.max(canvas.y, canvas.y + layout.originY / devicePixelRatio);
  const right = Math.min(
    canvas.x + canvas.width,
    canvas.x + layout.originX / devicePixelRatio + layout.documentWidth * scale,
  );
  const bottom = Math.min(
    canvas.y + canvas.height,
    canvas.y + layout.originY / devicePixelRatio + layout.documentHeight * scale,
  );
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * A drag from `start` by `by` (CSS pixels) over `moves` moves, wobbling a little across its
 * direction like a hand, and ending at `start + by`.
 */
export function dragPath(start: Point, by: Point, moves: number): Point[] {
  const length = Math.hypot(by.x, by.y) || 1;
  const across = { x: -by.y / length, y: by.x / length };
  return Array.from({ length: moves + 1 }, (_, index) => {
    const t = index / moves;
    const wobble = 6 * Math.sin(Math.PI * 6 * t);
    return {
      x: start.x + by.x * t + across.x * wobble,
      y: start.y + by.y * t + across.y * wobble,
    };
  });
}
