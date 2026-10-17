import type { ViewCommand } from "@openpaint/engine";
import type {
  ToolDescriptor,
  ToolPointerEvent,
  ToolRuntime,
  ToolViewState,
} from "@openpaint/extension-api";
import { type ZoomRectangle, zoomRectangle } from "./zoom-rect";

/** The Zoom tool stops at 6400 % (TL-ZOOM-01). The view's own range goes on to 10 000 % (UI-VIEW-01). */
export const ZOOM_TOOL_MAX_RATIO = 64;

/** A drag shorter than this many device pixels is still a click (TL-ZOOM-01). */
const CLICK_SLOP_DEVICE_PX = 4;

/** What the view tools need from the app. */
export interface ViewHost {
  /** Runs a navigation command on the engine. */
  readonly view: (command: ViewCommand) => void;
  /** The zoom in effect, in device pixels per image pixel, or undefined before the engine reports it. */
  readonly zoom: () => number | undefined;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** One press of the Zoom tool, from the button down to the release. Points are in image pixels. */
interface ZoomDrag {
  readonly button: number;
  readonly start: Point;
  end: Point;
  moved: boolean;
}

/**
 * A CSS cursor from a magnifier glyph, with `extra` drawn inside the lens. The hot spot is the lens
 * centre. Only the Zoom tool's two cursors that CSS does not name use it (TL-ZOOM-01).
 */
function magnifierCursor(extra: string): string {
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>" +
    "<circle cx='10' cy='10' r='6.5' fill='white' stroke='black' stroke-width='1.5'/>" +
    "<path d='M15 15l6 6' stroke='black' stroke-width='2.5' stroke-linecap='round'/>" +
    `${extra}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 10 10, crosshair`;
}

/** The rectangle-zoom cursor: a small rectangle inside the lens. */
const ZOOM_RECTANGLE_CURSOR = magnifierCursor(
  "<rect x='7.5' y='7.5' width='5' height='5' fill='none' stroke='black' stroke-width='1'/>",
);

/** The slide cursor of a middle-button drag over the Zoom tool: arrows inside the lens. */
const ZOOM_PAN_CURSOR = magnifierCursor(
  "<path d='M10 6v8M6 10h8' stroke='black' stroke-width='1.2'/>",
);

function pointOf(event: ToolPointerEvent): Point {
  return { x: event.x, y: event.y };
}

/** The image rectangle a drag covers, from its corners in either order. */
function rectangleOf(drag: ZoomDrag): ZoomRectangle {
  const x = Math.min(drag.start.x, drag.end.x);
  const y = Math.min(drag.start.y, drag.end.y);
  return {
    x,
    y,
    width: Math.max(drag.start.x, drag.end.x) - x,
    height: Math.max(drag.start.y, drag.end.y) - y,
  };
}

/**
 * The runtime of the Zoom tool (TL-ZOOM-01). A left click zooms in one preset around the point
 * clicked, and a right click zooms out. A left drag draws a rectangle, and release zooms to fit it.
 * A middle-button drag slides the view, and the engine handles it. A drag counts as a click until
 * it moves past a few device pixels. Right drags do nothing beyond the click.
 */
class ZoomRuntime implements ToolRuntime {
  readonly #host: ViewHost;
  #drag: ZoomDrag | undefined;

  constructor(host: ViewHost) {
    this.#host = host;
  }

  activate(): void {}

  deactivate(): void {
    this.cancel();
  }

  pointer(event: ToolPointerEvent): void {
    if (event.predicted === true) return;
    if (event.type === "down") {
      if (this.#drag !== undefined || (event.button !== 0 && event.button !== 2)) return;
      this.#drag = {
        button: event.button,
        start: pointOf(event),
        end: pointOf(event),
        moved: false,
      };
    } else if (event.type === "move") {
      const drag = this.#drag;
      if (drag !== undefined) this.#track(drag, event);
    } else if (event.type === "up") {
      const drag = this.#drag;
      if (drag === undefined) return;
      this.#track(drag, event);
      this.cancel();
      this.#finish(drag);
    } else {
      this.cancel();
    }
  }

  cursor(view: ToolViewState): string | undefined {
    if (view.panning) return ZOOM_PAN_CURSOR;
    const drag = this.#drag;
    if (drag?.button === 0 && drag.moved) return ZOOM_RECTANGLE_CURSOR;
    if (drag?.button === 2) return "zoom-out";
    return "zoom-in";
  }

  /** Stops the drag in progress and removes its outline. Nothing is zoomed. */
  cancel(): void {
    this.#drag = undefined;
    zoomRectangle.set(undefined);
  }

  #track(drag: ZoomDrag, event: ToolPointerEvent): void {
    drag.end = pointOf(event);
    if (!drag.moved) {
      const zoom = this.#host.zoom() ?? 1;
      const dx = drag.end.x - drag.start.x;
      const dy = drag.end.y - drag.start.y;
      drag.moved = Math.hypot(dx, dy) * zoom > CLICK_SLOP_DEVICE_PX;
    }
    if (drag.moved && drag.button === 0) zoomRectangle.set(rectangleOf(drag));
  }

  #finish(drag: ZoomDrag): void {
    if (drag.moved) {
      if (drag.button === 0) {
        this.#host.view({ type: "zoomToRect", ...rectangleOf(drag), maxZoom: ZOOM_TOOL_MAX_RATIO });
      }
      return;
    }
    const { x, y } = drag.start;
    if (drag.button === 0) {
      this.#host.view({ type: "zoomStepAt", direction: 1, x, y, maxZoom: ZOOM_TOOL_MAX_RATIO });
    } else {
      this.#host.view({ type: "zoomStepAt", direction: -1, x, y });
    }
  }
}

/**
 * The runtime of the Pan tool (TL-PAN-01). A left-button drag scrolls the view. The pointer
 * controller routes that drag to the engine (`panOnDrag`), so the runtime only shows the hand
 * cursors: open, closed while dragging, and invalid when the image fits the viewport.
 */
class PanRuntime implements ToolRuntime {
  readonly panOnDrag = true;

  activate(): void {}

  deactivate(): void {}

  pointer(): void {}

  cursor(view: ToolViewState): string {
    if (!view.canPan) return "not-allowed";
    return view.panning ? "grabbing" : "grab";
  }
}

/**
 * The runtime of a view tool, Zoom or Pan, or undefined for the other tools. Zoom and Pan change
 * only the view, so they never write the document.
 */
export function viewToolRuntime(tool: ToolDescriptor, host: ViewHost): ToolRuntime | undefined {
  if (tool.id === "zoom") return new ZoomRuntime(host);
  if (tool.id === "pan") return new PanRuntime();
  return undefined;
}
