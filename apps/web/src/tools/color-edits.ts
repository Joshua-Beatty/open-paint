import type { ColorRgba8 } from "@openpaint/document";
import type { SettingChange } from "@openpaint/storage";
import {
  type ColorSettings,
  PRIMARY_COLOR_PATH,
  readStoredColor,
  SECONDARY_COLOR_PATH,
} from "../colors/use-colors";
import { FrameCoalescer, type ScheduleFrame } from "./frame-coalescer";

const BLACK: ColorRgba8 = { r: 0, g: 0, b: 0, a: 255 };
const WHITE: ColorRgba8 = { r: 255, g: 255, b: 255, a: 255 };

/**
 * Color changes that follow each other within this many milliseconds merge into one "Change Color"
 * step (TL-FRAME-02), so a drag on the color wheel or a swap records once, as nudges do (TL-MOVE-01).
 */
export const COLOR_MERGE_MS = 500;

/** Whether a setting change is a local change of the primary or the secondary color. */
export function isColorChange(change: SettingChange): boolean {
  return (
    change.source === "local" &&
    (change.path === PRIMARY_COLOR_PATH || change.path === SECONDARY_COLOR_PATH)
  );
}

export function sameColor(a: ColorRgba8, b: ColorRgba8): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

/**
 * The color a tool paints with and the other one (TL-FRAME-03): the primary and the secondary for
 * the left button, swapped for the right.
 */
export function paintColors(
  settings: ColorSettings,
  button: number,
): { readonly color: ColorRgba8; readonly background: ColorRgba8 } {
  const primary = readStoredColor(settings, PRIMARY_COLOR_PATH, BLACK);
  const secondary = readStoredColor(settings, SECONDARY_COLOR_PATH, WHITE);
  return button === 2
    ? { color: secondary, background: primary }
    : { color: primary, background: secondary };
}

/** The color edits that have not been recorded yet, so Undo and Redo can record them first. */
const unsettled = new Set<ColorEdits>();

/**
 * Records every color change still waiting to merge (see `ColorEdits`). Undo and Redo call it first,
 * so they step back from what the canvas shows.
 */
export function settleColorEdits(): void {
  for (const edits of [...unsettled]) edits.flush();
}

export interface ColorEditsOptions {
  readonly scheduleFrame?: ScheduleFrame;
  /** Draws the pending result in the new colors, with no history item. */
  readonly preview: () => void;
  /** Records the pending result in its current colors as one "Change Color" step. */
  readonly record: () => void;
}

/**
 * The color changes of a pending tool result (TL-FRAME-01: changing colors re-renders it). Each
 * change draws the result again on the next frame, at most once per frame (L1), and the changes
 * that follow each other record one step once they stop for COLOR_MERGE_MS, or as soon as the tool
 * does anything else (`flush`).
 */
export class ColorEdits {
  readonly #options: ColorEditsOptions;
  readonly #frames: FrameCoalescer;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ColorEditsOptions) {
    this.#options = options;
    this.#frames = new FrameCoalescer(options.scheduleFrame);
  }

  /** Whether a change is drawn or waiting to be drawn but not recorded. */
  get pending(): boolean {
    return unsettled.has(this);
  }

  /** A color changed: draw the result on the next frame and record it once the changes stop. */
  changed(): void {
    unsettled.add(this);
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.flush();
    }, COLOR_MERGE_MS);
    this.#frames.request(() => this.#options.preview());
  }

  /** Records the waiting changes now, if any. */
  flush(): void {
    if (!this.pending) return;
    this.#drop();
    this.#options.record();
  }

  /** Forgets the waiting changes without recording them; the caller puts the layer back. */
  cancel(): void {
    this.#drop();
  }

  #drop(): void {
    unsettled.delete(this);
    this.#clearTimer();
    this.#frames.cancel();
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
