import { isEmptyRect, rect } from "@openpaint/document";
import type { ToolPointerEvent, ToolRuntime, ToolViewState } from "@openpaint/extension-api";
import { PRIMARY_COLOR_PATH, readStoredColor, SECONDARY_COLOR_PATH } from "../colors/use-colors";
import { averageColor, sampleArea, sampleSizeOf } from "./color-sample";
import { PICK_IMAGE_CURSOR, PICK_LAYER_CURSOR } from "./cursors";
import type { PaintHost } from "./paint-tools";

const BLACK = { r: 0, g: 0, b: 0, a: 255 };

/**
 * The Color Picker (TL-PICK-01). The left button sets the primary color and the right button the
 * secondary one, and both follow the pointer while it is held. Each sample averages the sampling
 * square under the pointer, from the active layer or the merged image, and the merged image is used
 * while Ctrl is held. A click then applies the "After click" choice. Nothing is recorded in history.
 */
class ColorPickerRuntime implements ToolRuntime {
  readonly #host: PaintHost;
  /** The button of the press in progress. Undefined while no button is held. */
  #button: number | undefined;

  constructor(host: PaintHost) {
    this.#host = host;
  }

  activate(): void {}

  deactivate(): void {
    this.#button = undefined;
  }

  /**
   * A crosshair with a pipette, and a stack of layers beside it while the merged image is sampled:
   * by the option, or while Ctrl is held (TL-PICK-01).
   */
  cursor(view: ToolViewState): string | undefined {
    if (view.panning) return undefined;
    return view.ctrlKey === true || this.#samplesImage() ? PICK_IMAGE_CURSOR : PICK_LAYER_CURSOR;
  }

  pointer(event: ToolPointerEvent): void {
    try {
      if (event.type === "down") {
        if (event.button !== 0 && event.button !== 2) return;
        this.#button = event.button;
        this.#pick(event, event.button);
      } else if (event.type === "move") {
        if (this.#button !== undefined && event.predicted !== true) this.#pick(event, this.#button);
      } else if (event.type === "up") {
        const button = this.#button;
        this.#button = undefined;
        if (button === undefined) return;
        this.#pick(event, button);
        this.#afterClick();
      } else {
        this.#button = undefined;
      }
    } catch (cause) {
      this.#button = undefined;
      this.#host.report(cause);
    }
  }

  #samplesImage(): boolean {
    return this.#host.settings()?.get("tools.sampleAllLayers") === true;
  }

  /** Sets the color of `button` to the average under the pointer, unless the point misses the image. */
  #pick(event: ToolPointerEvent, button: number): void {
    const settings = this.#host.settings();
    const document = this.#host.document();
    if (settings === null || document === undefined) return;
    const area = sampleArea(
      event.x,
      event.y,
      sampleSizeOf(settings.get("tools.sampleMode")),
      rect(0, 0, document.width, document.height),
    );
    if (isEmptyRect(area)) return;
    const image = event.ctrlKey || this.#samplesImage();
    const pixels = image
      ? document.compositeArea(area)
      : document.activeLayer?.pixels.readRegion(area);
    if (pixels === undefined) return;
    const color = averageColor(pixels);
    const path = button === 0 ? PRIMARY_COLOR_PATH : SECONDARY_COLOR_PATH;
    const current = readStoredColor(settings, path, BLACK);
    if (
      current.r === color.r &&
      current.g === color.g &&
      current.b === color.b &&
      current.a === color.a
    )
      return;
    settings.set(path, { r: color.r, g: color.g, b: color.b, a: color.a });
  }

  /** The "After click" choice (TL-PICK-01): stay, return to the last tool, or take the Pencil. */
  #afterClick(): void {
    const behavior = this.#host.settings()?.get("tools.colorPicker.clickBehavior");
    if (behavior === "SwitchToLastTool") {
      const previous = this.#host.previousTool?.();
      if (previous !== undefined) this.#host.activateTool?.(previous);
    } else if (behavior === "SwitchToPencilTool") {
      this.#host.activateTool?.("pencil");
    }
  }
}

/** The runtime of the Color Picker (TL-PICK-01). */
export function colorPickerToolRuntime(host: PaintHost): ToolRuntime {
  return new ColorPickerRuntime(host);
}
