import type {
  Document,
  Rect,
  Selection,
  SelectionCombineMode,
  SelectionPolygon,
  Size,
} from "@openpaint/document";
import type {
  ToolDescriptor,
  ToolPointerEvent,
  ToolRuntime,
  ToolViewState,
} from "@openpaint/extension-api";
import type { MessageId } from "@openpaint/i18n";
import { ClickDeadZone } from "@openpaint/tools";
import { CROSSHAIR_CURSOR } from "./cursors";
import { lassoToolRuntime } from "./lasso-tools";
import { magicWandToolRuntime } from "./magic-wand-tools";
import type { PaintHost } from "./paint-tools";
import {
  combineModeFor,
  combineModeOf,
  type DrawMode,
  dragRect,
  drawModeOf,
  fixedSizeRect,
  lengthInPixels,
  type PixelPoint,
  ratioRect,
  type SizeUnit,
  shapePolygons,
  sizeUnitOf,
} from "./select-geometry";
import { reportToolFailure } from "./tool-failure";

/** The tools that select by drawing a shape: Rectangle Select and Ellipse Select (TL-SEL-01). */
export type SelectShapeToolId = "rectangleSelect" | "ellipseSelect";

/** The history name of each shape tool (TL-SEL-01: named after the tool). */
const HISTORY_KEYS = {
  rectangleSelect: "history.rectangleSelect",
  ellipseSelect: "history.ellipseSelect",
} as const satisfies Record<SelectShapeToolId, MessageId>;

const SHAPES = {
  rectangleSelect: "rectangle",
  ellipseSelect: "ellipse",
} as const satisfies Record<SelectShapeToolId, "rectangle" | "ellipse">;

/** The Fixed Ratio and Fixed Size defaults (TL-SEL-RECT-01). */
const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 300;

/** One drag of a shape tool, from the press to the release. */
interface Drag {
  readonly document: Document;
  /** The selection before the drag. The preview is drawn over it, and the commit combines with it. */
  readonly before: Selection;
  readonly toolId: SelectShapeToolId;
  readonly mode: SelectionCombineMode;
  readonly drawMode: DrawMode;
  /** Fixed Ratio: the width over the height. */
  readonly ratio: number;
  /** Fixed Size: the size in pixels. */
  readonly size: { readonly width: number; readonly height: number };
  /** The press stays a click until the pointer leaves this zone around it (TL-SEL-01). */
  readonly zone: ClickDeadZone;
  start: PixelPoint;
  end: PixelPoint;
  last: PixelPoint;
  /** Move-origin mode: the shape moves with the pointer instead of resizing (TL-SEL-01). */
  translating: boolean;
  square: boolean;
}

function isSelectShapeTool(id: string): id is SelectShapeToolId {
  return id === "rectangleSelect" || id === "ellipseSelect";
}

function pixelOf(event: ToolPointerEvent): PixelPoint {
  return { x: Math.floor(event.x), y: Math.floor(event.y) };
}

/** The rectangle the drag's Draw mode gives (TL-SEL-RECT-01), before it is clipped to the canvas. */
function areaOf(drag: Drag, canvas: Size): Rect {
  switch (drag.drawMode) {
    case "fixedSize":
      return fixedSizeRect(drag.start, drag.size.width, drag.size.height, canvas);
    case "fixedRatio":
      return ratioRect(drag.start, drag.end, drag.ratio);
    case "normal":
      return dragRect(drag.start, drag.end, drag.square);
  }
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === "number" && value > 0 ? value : fallback;
}

/**
 * The runtime of Rectangle Select and Ellipse Select. A drag previews its shape over the selection
 * it started with, without history. Release restores that selection and combines the shape as one
 * history item named after the tool. A press whose pointer stays within a few CSS pixels of where
 * it went down is a click, and shows no preview. A click deselects in Replace mode and does nothing
 * otherwise (TL-SEL-01). A drag that leaves that zone draws from the press point. Cancel restores
 * the selection the drag started with.
 */
class SelectionRuntime implements ToolRuntime {
  readonly #toolId: SelectShapeToolId;
  readonly #host: PaintHost;
  #drag: Drag | undefined;

  constructor(toolId: SelectShapeToolId, host: PaintHost) {
    this.#toolId = toolId;
    this.#host = host;
  }

  activate(): void {}

  deactivate(): void {
    this.cancel();
  }

  /** A precise crosshair, since the shape starts at the pixel under it (TL-SEL-01). */
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
    const read = (name: string) => settings.get(`tools.${name}`);
    const drawMode = drawModeOf(read("selection.drawMode"));
    const width = positiveOr(read("selection.drawWidth"), DEFAULT_WIDTH);
    const height = positiveOr(read("selection.drawHeight"), DEFAULT_HEIGHT);
    const unit: SizeUnit = sizeUnitOf(read("selection.drawUnits"));
    const point = pixelOf(event);
    const next: Drag = {
      document,
      before: document.selection,
      toolId: this.#toolId,
      mode: combineModeFor(event, combineModeOf(read("selection.combineMode"))),
      drawMode,
      ratio: width / height,
      size: {
        width: lengthInPixels(width, unit, document.resolution),
        height: lengthInPixels(height, unit, document.resolution),
      },
      zone: new ClickDeadZone(event),
      start: point,
      end: point,
      last: point,
      translating: false,
      square: event.shiftKey,
    };
    this.#drag = next;
    if (drawMode === "fixedSize") this.#show(next);
  }

  #move(event: ToolPointerEvent): void {
    const drag = this.#drag;
    if (drag === undefined || event.predicted === true) return;
    this.#track(drag, event);
    if (drag.zone.left || drag.drawMode === "fixedSize") this.#show(drag);
  }

  #finish(event: ToolPointerEvent): void {
    const drag = this.#drag;
    if (drag === undefined) return;
    this.#track(drag, event);
    this.#drag = undefined;
    drag.document.restoreSelection(drag.before);
    const clicked = drag.drawMode !== "fixedSize" && !drag.zone.left;
    const polygons = clicked ? [] : this.#polygons(drag);
    if (polygons.length === 0) {
      if (drag.mode === "replace") drag.document.deselect();
      return;
    }
    drag.document.combineSelection(
      polygons,
      drag.mode,
      this.#host.translate(HISTORY_KEYS[drag.toolId]),
    );
  }

  /** Follows the pointer: the far corner, the placed rectangle, or the whole shape when translating. */
  #track(drag: Drag, event: ToolPointerEvent): void {
    const point = pixelOf(event);
    const dx = point.x - drag.last.x;
    const dy = point.y - drag.last.y;
    drag.last = point;
    drag.square = event.shiftKey;
    if (drag.translating) {
      drag.start = { x: drag.start.x + dx, y: drag.start.y + dy };
      drag.end = { x: drag.end.x + dx, y: drag.end.y + dy };
    } else if (drag.drawMode === "fixedSize") {
      drag.start = point;
    } else {
      drag.end = point;
    }
    drag.zone.track(event);
  }

  /** Previews the drag's shape combined with the selection it started with. */
  #show(drag: Drag): void {
    drag.document.previewSelection(drag.before.combine(this.#polygons(drag), drag.mode));
  }

  /** The shape's polygons, clipped to the canvas (TL-SEL-01). Empty when it lies off the canvas. */
  #polygons(drag: Drag): SelectionPolygon[] {
    const canvas = { width: drag.document.width, height: drag.document.height };
    return shapePolygons(SHAPES[drag.toolId], areaOf(drag, canvas), canvas);
  }

  #fail(cause: unknown): void {
    reportToolFailure(this.#host, cause);
  }
}

/**
 * The runtime of a selection tool: Rectangle Select, Ellipse Select, Lasso Select or Magic Wand, or
 * undefined for the other tools.
 */
export function selectionToolRuntime(
  tool: ToolDescriptor,
  host: PaintHost,
): ToolRuntime | undefined {
  if (isSelectShapeTool(tool.id)) return new SelectionRuntime(tool.id, host);
  if (tool.id === "lassoSelect") return lassoToolRuntime(host);
  if (tool.id === "magicWand") return magicWandToolRuntime(host);
  return undefined;
}
