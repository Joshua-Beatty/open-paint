import {
  CM_PER_INCH,
  DEFAULT_DPI,
  type Resolution,
  type Size,
  type Surface,
} from "@openpaint/document";

/**
 * How the printed image fills the page (FMT-PRN-01). Fit to page is the default. Actual size prints
 * the image at the document's resolution.
 */
export type PrintMode = "fit" | "actual";

/** The CSS sizes of the printed image. Fit to page uses the whole printable area. */
export interface PrintLayout {
  readonly mode: PrintMode;
  readonly width: string;
  readonly height: string;
}

/** The flattened image and how it is laid out on the page. */
export interface PrintJob {
  /** A PNG data URL of the flattened image. */
  readonly src: string;
  readonly alt: string;
  readonly layout: PrintLayout;
}

/**
 * The browser side of printing: whether `window.print` exists, how the flattened pixels are
 * encoded for the print view, and the print itself. Kept apart so the flow can be tested.
 */
export interface Printer {
  readonly available: () => boolean;
  /** A PNG data URL of the surface, or nothing when the browser cannot encode it. */
  readonly encode: (surface: Surface) => string | undefined;
  /** Shows the job in the print-only view and opens the browser's print dialog. */
  readonly print: (job: PrintJob) => Promise<void>;
}

/**
 * The page layout of an image. Actual size converts the pixels to inches with the document's
 * resolution on each axis. A pixel resolution has no physical size, so it uses the screen's 96 per
 * inch, as CSS does.
 */
export function printLayout(size: Size, resolution: Resolution, mode: PrintMode): PrintLayout {
  if (mode === "fit") return { mode, width: "100%", height: "100%" };
  return {
    mode,
    width: `${size.width / dotsPerInch(resolution.x, resolution.unit)}in`,
    height: `${size.height / dotsPerInch(resolution.y, resolution.unit)}in`,
  };
}

function dotsPerInch(dotsPerUnit: number, unit: Resolution["unit"]): number {
  if (unit === "pixel") return DEFAULT_DPI;
  return unit === "centimeter" ? dotsPerUnit * CM_PER_INCH : dotsPerUnit;
}
