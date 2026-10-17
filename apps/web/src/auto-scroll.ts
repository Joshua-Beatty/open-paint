import { ClickDeadZone } from "@openpaint/tools";

/** The width of the edge band, in CSS pixels, where auto-scroll starts (TL-HOTKEY-03). */
export const AUTO_SCROLL_BAND_CSS_PIXELS = 24;

/** The auto-scroll settings a drawing tool reads (ui.autoScrollWhileDrawing, workspace.autoScrollSpeed). */
export interface AutoScrollSettings {
  readonly enabled: boolean;
  /** Screen pixels per second at full speed. */
  readonly speed: number;
}

/** The factory values of the two settings (SET-STO-03). */
export const DEFAULT_AUTO_SCROLL: AutoScrollSettings = { enabled: true, speed: 2000 };

/**
 * The view movement, in CSS pixels, for a drawing pointer held near the edge of a viewport for
 * `seconds`. The speed ramps up across the band inside each edge and reaches full speed at the edge,
 * staying there past it. A pointer near the start edge pans the image toward that edge (a positive
 * movement), and a pointer near the end edge pans it the other way, so the content beyond the pointer
 * comes into view.
 */
export function autoScrollDelta(
  pointer: { readonly x: number; readonly y: number },
  view: { readonly width: number; readonly height: number },
  settings: AutoScrollSettings,
  seconds: number,
): { readonly dx: number; readonly dy: number } {
  if (!settings.enabled || !(seconds > 0)) return { dx: 0, dy: 0 };
  const rate = settings.speed * seconds;
  return {
    dx: axisRatio(pointer.x, view.width) * rate,
    dy: axisRatio(pointer.y, view.height) * rate,
  };
}

/** The signed share of full speed along one axis: positive near the start, negative near the end. */
function axisRatio(position: number, length: number): number {
  const band = Math.min(AUTO_SCROLL_BAND_CSS_PIXELS, length / 2);
  if (!(band > 0)) return 0;
  const intoStart = band - position;
  if (intoStart > 0) return Math.min(1, intoStart / band);
  const intoEnd = position - (length - band);
  if (intoEnd > 0) return -Math.min(1, intoEnd / band);
  return 0;
}

/**
 * Whether a drawing press may auto-scroll yet (TL-HOTKEY-03). A press is a click until the pointer
 * leaves the 4 CSS px click dead zone, and a click near the canvas edge must not scroll the view
 * (which would also turn Zoom to Window into a fixed view). Once the press is a drag it scrolls,
 * and keeps scrolling while the pointer is held still at the edge.
 */
export class AutoScrollPress {
  readonly #zone: ClickDeadZone;

  constructor(press: { readonly clientX: number; readonly clientY: number }) {
    this.#zone = new ClickDeadZone({
      x: press.clientX,
      y: press.clientY,
      clientX: press.clientX,
      clientY: press.clientY,
    });
  }

  /** Follows a pointer move of the press. */
  move(sample: { readonly clientX: number; readonly clientY: number }): void {
    this.#zone.track({ x: sample.clientX, y: sample.clientY, ...sample });
  }

  /** True once the press has become a drag. */
  get armed(): boolean {
    return this.#zone.left;
  }
}
