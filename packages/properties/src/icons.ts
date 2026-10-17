/**
 * The icon data of a property, a choice or a toolbar button: a string, so schemas stay plain data.
 * Plain SVG path data is an outline on a 16 x 16 grid, stroked in the text color at the toolbar's
 * weight. Data made by `filledIcon` is a filled shape on its own square grid, such as an icon set's
 * 256 or 24 unit grid, filled in the text color.
 */

const FILLED = /^fill:(\d+(?:\.\d+)?):(.+)$/s;

/** Icon data for a filled shape drawn on a `0 0 grid grid` view box. */
export function filledIcon(grid: number, path: string): string {
  return `fill:${grid}:${path}`;
}

/** How to draw icon data. */
export interface IconShape {
  readonly viewBox: string;
  readonly path: string;
  /** Filled in the text color, rather than stroked. */
  readonly filled: boolean;
}

export function iconShape(icon: string): IconShape {
  const filled = FILLED.exec(icon);
  if (filled === null) return { viewBox: "0 0 16 16", path: icon, filled: false };
  const [, grid = "16", path = ""] = filled;
  return { viewBox: `0 0 ${grid} ${grid}`, path, filled: true };
}
