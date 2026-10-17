import type { Document, Selection, SelectionCombineMode } from "@openpaint/document";
import type { ToolPointerEvent, ToolRuntime, ToolViewState } from "@openpaint/extension-api";
import { ClickDeadZone } from "@openpaint/tools";
import { CROSSHAIR_CURSOR } from "./cursors";
import type { PaintHost } from "./paint-tools";
import { combineModeFor, combineModeOf, lassoPolygons, type PixelPoint } from "./select-geometry";
import { reportToolFailure } from "./tool-failure";

/** One drag of the Lasso, from the press to the release. */
interface LassoDrag {
  readonly document: Document;
  /** The selection before the drag. The preview is drawn over it, and the commit combines with it. */
  readonly before: Selection;
  readonly mode: SelectionCombineMode;
  /** The press stays a click until the pointer leaves this zone around it (TL-SEL-01). */
  readonly zone: ClickDeadZone;
  /** The freeform path in whole pixels. The polygon closes between its last and first points. */
  points: PixelPoint[];
  last: PixelPoint;
  /** Move-origin mode: the whole path moves with the pointer instead of growing (TL-SEL-01). */
  translating: boolean;
}

function pixelOf(event: ToolPointerEvent): PixelPoint {
  return { x: Math.floor(event.x), y: Math.floor(event.y) };
}

/**
 * The runtime of Lasso Select (TL-SEL-LASSO-01). A drag traces a freeform path, which is previewed
 * over the selection it started with. Release combines the closed path as one history item named
 * "Lasso Select". A press whose pointer stays within a few CSS pixels of where it went down is a
 * click and shows no preview, and a click or a path without an enclosed area deselects in Replace
 * mode and does nothing otherwise (TL-SEL-01). Cancel restores the selection the drag started with.
 */
class LassoRuntime implements ToolRuntime {
  readonly #host: PaintHost;
  #drag: LassoDrag | undefined;

  constructor(host: PaintHost) {
    this.#host = host;
  }

  activate(): void {}

  deactivate(): void {
    this.cancel();
  }

  /** A precise crosshair, since the path follows the pixel under it (TL-SEL-01). */
  cursor(view: ToolViewState): string | undefined {
    return view.panning ? undefined : CROSSHAIR_CURSOR;
  }

  pointer(event: ToolPointerEvent): void {
    try {
      if (event.type === "down") this.#start(event);
      else if (event.type === "move") this.#move(event);
      else if (event.type === "up") this.#finish(event);
      else this.cancel();
    } catch (cause) {
      this.cancel();
      this.#fail(cause);
    }
  }

  /** Stops the drag in progress and restores the selection it started with. Nothing is recorded. */
  cancel(): void {
    const drag = this.#drag;
    if (drag === undefined) return;
    this.#drag = undefined;
    drag.document.restoreSelection(drag.before);
  }

  #start(event: ToolPointerEvent): void {
    const drag = this.#drag;
    if (drag !== undefined) {
      drag.translating = true;
      drag.last = pixelOf(event);
      return;
    }
    if (event.button !== 0 && event.button !== 2) return;
    const settings = this.#host.settings();
    const document = this.#host.document();
    if (settings === null || document === undefined) return;
    const point = pixelOf(event);
    this.#drag = {
      document,
      before: document.selection,
      mode: combineModeFor(event, combineModeOf(settings.get("tools.selection.combineMode"))),
      zone: new ClickDeadZone(event),
      points: [point],
      last: point,
      translating: false,
    };
  }

  #move(event: ToolPointerEvent): void {
    const drag = this.#drag;
    if (drag === undefined || event.predicted === true) return;
    this.#track(drag, event);
    if (drag.zone.left) this.#show(drag);
  }

  #finish(event: ToolPointerEvent): void {
    const drag = this.#drag;
    if (drag === undefined) return;
    this.#track(drag, event);
    this.#drag = undefined;
    drag.document.restoreSelection(drag.before);
    const clicked = !drag.zone.left;
    const polygons = clicked ? [] : lassoPolygons(drag.points, canvasOf(drag.document));
    if (polygons.length === 0) {
      if (drag.mode === "replace") drag.document.deselect();
      return;
    }
    drag.document.combineSelection(
      polygons,
      drag.mode,
      this.#host.translate("history.lassoSelect"),
    );
  }

  /** Adds the pointer sample to the path, or moves the whole path when translating. */
  #track(drag: LassoDrag, event: ToolPointerEvent): void {
    const point = pixelOf(event);
    if (drag.translating) {
      const dx = point.x - drag.last.x;
      const dy = point.y - drag.last.y;
      drag.points = drag.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    } else {
      const tail = drag.points.at(-1);
      if (tail === undefined || tail.x !== point.x || tail.y !== point.y) drag.points.push(point);
    }
    drag.last = point;
    drag.zone.track(event);
  }

  /** Previews the path's area combined with the selection the drag started with. */
  #show(drag: LassoDrag): void {
    const polygons = lassoPolygons(drag.points, canvasOf(drag.document));
    drag.document.previewSelection(drag.before.combine(polygons, drag.mode));
  }

  #fail(cause: unknown): void {
    reportToolFailure(this.#host, cause);
  }
}

function canvasOf(document: Document): { readonly width: number; readonly height: number } {
  return { width: document.width, height: document.height };
}

/** The runtime of Lasso Select (TL-SEL-LASSO-01). */
export function lassoToolRuntime(host: PaintHost): ToolRuntime {
  return new LassoRuntime(host);
}
