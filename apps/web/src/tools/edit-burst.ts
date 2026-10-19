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
 * Option and color changes of a pending tool result that follow each other within this many
 * milliseconds, with no mouse button held, merge into one Edit step (TL-FRAME-02), so a drag on a
 * slider or the color wheel records once, as nudges do (TL-MOVE-01).
 */
export const EDIT_MERGE_MS = 500;

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

/** The bursts that have not been recorded yet, so Undo and Redo can record them first. */
const unsettled = new Set<EditBurst>();

/**
 * Records every option or color change still waiting to merge (see `EditBurst`). Undo and Redo call
 * it first, so they step back from what the canvas shows.
 */
export function settleEditBursts(): void {
  for (const burst of [...unsettled]) burst.flush();
}

/** The mouse buttons held anywhere in the page, and what waits for them to be released. */
const buttons = {
  held: 0,
  watching: false,
  released: new Set<() => void>(),
};

/** Follows the page's mouse buttons, once, where there is a page. */
function watchButtons(): void {
  if (buttons.watching || typeof window === "undefined") return;
  buttons.watching = true;
  window.addEventListener(
    "pointerdown",
    (event) => {
      buttons.held = event.buttons;
    },
    true,
  );
  const release = (event: PointerEvent) => {
    buttons.held = event.type === "pointerup" ? event.buttons : 0;
    if (buttons.held !== 0) return;
    const waiting = [...buttons.released];
    buttons.released.clear();
    for (const callback of waiting) callback();
  };
  window.addEventListener("pointerup", release, true);
  window.addEventListener("pointercancel", release, true);
}

export interface EditBurstOptions {
  readonly scheduleFrame?: ScheduleFrame;
  /** Draws the pending result with the new values, with no history item. */
  readonly preview: () => void;
  /** Records the pending result as it is now as one step named `name` (a message id). */
  readonly record: (name: string) => void;
}

/**
 * The option and color changes of a pending tool result (TL-FRAME-01: they re-render it). Each
 * change draws the result again on the next frame, at most once per frame (L1), and the changes
 * that follow each other record one step, named after the latest, once they stop for
 * EDIT_MERGE_MS with no mouse button held, or as soon as the tool does anything else (`flush`).
 */
export class EditBurst {
  readonly #options: EditBurstOptions;
  readonly #frames: FrameCoalescer;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #name = "";
  readonly #whenReleased = () => {
    this.flush();
  };

  constructor(options: EditBurstOptions) {
    this.#options = options;
    this.#frames = new FrameCoalescer(options.scheduleFrame);
    watchButtons();
  }

  /** Whether a change is drawn or waiting to be drawn but not recorded. */
  get pending(): boolean {
    return unsettled.has(this);
  }

  /** An option or a color changed: draw the result next frame and record it once the changes stop. */
  changed(name: string): void {
    unsettled.add(this);
    this.#name = name;
    this.#clearTimer();
    buttons.released.delete(this.#whenReleased);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      // A slider still being dragged keeps the burst open until it is let go.
      if (buttons.held !== 0) buttons.released.add(this.#whenReleased);
      else this.flush();
    }, EDIT_MERGE_MS);
    this.#frames.request(() => this.#options.preview());
  }

  /** Records the waiting changes now, if any. */
  flush(): void {
    if (!this.pending) return;
    this.#drop();
    this.#options.record(this.#name);
  }

  /** Forgets the waiting changes without recording them; the caller puts the result back. */
  cancel(): void {
    this.#drop();
  }

  #drop(): void {
    unsettled.delete(this);
    buttons.released.delete(this.#whenReleased);
    this.#clearTimer();
    this.#frames.cancel();
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
