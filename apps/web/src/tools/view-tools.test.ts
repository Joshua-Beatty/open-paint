import type { ToolPointerEvent } from "@openpaint/extension-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_REGISTRY } from "./roster";
import { type ViewHost, viewToolRuntime, ZOOM_TOOL_MAX_RATIO } from "./view-tools";
import { zoomRectangle } from "./zoom-rect";

function toolNamed(id: string) {
  const tool = TOOL_REGISTRY.get(id);
  if (tool === undefined) throw new Error(`No tool "${id}".`);
  return tool;
}

function host(zoom: number | undefined = 1) {
  return { view: vi.fn<ViewHost["view"]>(), zoom: () => zoom };
}

function sample(
  type: ToolPointerEvent["type"],
  x: number,
  y: number,
  button = 0,
  predicted = false,
): ToolPointerEvent {
  return {
    type,
    x,
    y,
    button,
    pressure: 0.5,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    ...(predicted ? { predicted: true } : {}),
  };
}

afterEach(() => {
  zoomRectangle.set(undefined);
});

describe("Zoom tool clicks (TL-ZOOM-01)", () => {
  it("zooms in one preset around the clicked point, up to 6400 %", () => {
    const view = host();
    const runtime = viewToolRuntime(toolNamed("zoom"), view);
    runtime?.pointer(sample("down", 10, 20));
    runtime?.pointer(sample("up", 10, 20));
    expect(view.view).toHaveBeenCalledWith({
      type: "zoomStepAt",
      direction: 1,
      x: 10,
      y: 20,
      maxZoom: ZOOM_TOOL_MAX_RATIO,
    });
    expect(ZOOM_TOOL_MAX_RATIO).toBe(64);
  });

  it("zooms out with a right click, with no cap", () => {
    const view = host();
    const runtime = viewToolRuntime(toolNamed("zoom"), view);
    runtime?.pointer(sample("down", 3, 4, 2));
    runtime?.pointer(sample("up", 3, 4, 2));
    expect(view.view).toHaveBeenCalledWith({ type: "zoomStepAt", direction: -1, x: 3, y: 4 });
  });

  it("treats a movement under a few device pixels as a click", () => {
    const view = host(2);
    const runtime = viewToolRuntime(toolNamed("zoom"), view);
    runtime?.pointer(sample("down", 10, 10));
    runtime?.pointer(sample("move", 10.5, 10));
    runtime?.pointer(sample("up", 10.5, 10));
    expect(view.view).toHaveBeenCalledTimes(1);
    expect(view.view.mock.calls[0]?.[0]).toMatchObject({ type: "zoomStepAt", direction: 1 });
  });

  it("ignores predicted samples", () => {
    const view = host();
    const runtime = viewToolRuntime(toolNamed("zoom"), view);
    runtime?.pointer(sample("down", 10, 10));
    runtime?.pointer(sample("move", 90, 90, 0, true));
    expect(zoomRectangle.state).toBeUndefined();
    runtime?.pointer(sample("up", 10, 10));
    expect(view.view).toHaveBeenCalledWith(expect.objectContaining({ type: "zoomStepAt" }));
  });
});

describe("Zoom tool rectangle (TL-ZOOM-01)", () => {
  it("draws the rectangle while the left button moves, then zooms to it on release", () => {
    const view = host();
    const runtime = viewToolRuntime(toolNamed("zoom"), view);
    runtime?.pointer(sample("down", 10, 20));
    runtime?.pointer(sample("move", 4, 30));
    expect(zoomRectangle.state).toEqual({ x: 4, y: 20, width: 6, height: 10 });
    runtime?.pointer(sample("up", 4, 30));
    expect(zoomRectangle.state).toBeUndefined();
    expect(view.view).toHaveBeenCalledTimes(1);
    expect(view.view).toHaveBeenCalledWith({
      type: "zoomToRect",
      x: 4,
      y: 20,
      width: 6,
      height: 10,
      maxZoom: ZOOM_TOOL_MAX_RATIO,
    });
  });

  it("cancels the drag and removes the outline without zooming", () => {
    const view = host();
    const runtime = viewToolRuntime(toolNamed("zoom"), view);
    runtime?.pointer(sample("down", 0, 0));
    runtime?.pointer(sample("move", 50, 50));
    runtime?.pointer(sample("cancel", 50, 50));
    expect(zoomRectangle.state).toBeUndefined();
    expect(view.view).not.toHaveBeenCalled();
  });

  it("removes the outline when the tool is deactivated", () => {
    const runtime = viewToolRuntime(toolNamed("zoom"), host());
    runtime?.pointer(sample("down", 0, 0));
    runtime?.pointer(sample("move", 50, 50));
    runtime?.deactivate();
    expect(zoomRectangle.state).toBeUndefined();
  });

  it("does nothing for a right-button drag beyond the click", () => {
    const view = host();
    const runtime = viewToolRuntime(toolNamed("zoom"), view);
    runtime?.pointer(sample("down", 0, 0, 2));
    runtime?.pointer(sample("move", 50, 50, 2));
    expect(zoomRectangle.state).toBeUndefined();
    runtime?.pointer(sample("up", 50, 50, 2));
    expect(view.view).not.toHaveBeenCalled();
  });
});

describe("Zoom tool cursors (TL-ZOOM-01)", () => {
  it("shows zoom-in over the canvas and zoom-out while the right button is held", () => {
    const runtime = viewToolRuntime(toolNamed("zoom"), host());
    expect(runtime?.cursor?.({ canPan: true, panning: false })).toBe("zoom-in");
    runtime?.pointer(sample("down", 1, 1, 2));
    expect(runtime?.cursor?.({ canPan: true, panning: false })).toBe("zoom-out");
  });

  it("shows the rectangle cursor during a left drag and the slide cursor while panning", () => {
    const runtime = viewToolRuntime(toolNamed("zoom"), host());
    runtime?.pointer(sample("down", 1, 1));
    expect(runtime?.cursor?.({ canPan: true, panning: false })).toBe("zoom-in");
    runtime?.pointer(sample("move", 30, 30));
    const rectangle = runtime?.cursor?.({ canPan: true, panning: false });
    expect(rectangle).toContain("data:image/svg+xml");
    expect(runtime?.cursor?.({ canPan: true, panning: true })).not.toBe(rectangle);
    expect(runtime?.cursor?.({ canPan: true, panning: true })).toContain("data:image/svg+xml");
  });
});

describe("Pan tool (TL-PAN-01)", () => {
  it("takes left drags for the view", () => {
    const runtime = viewToolRuntime(toolNamed("pan"), host());
    expect(runtime?.panOnDrag).toBe(true);
  });

  it("shows open, closed and invalid hands", () => {
    const runtime = viewToolRuntime(toolNamed("pan"), host());
    expect(runtime?.cursor?.({ canPan: true, panning: false })).toBe("grab");
    expect(runtime?.cursor?.({ canPan: true, panning: true })).toBe("grabbing");
    expect(runtime?.cursor?.({ canPan: false, panning: false })).toBe("not-allowed");
    expect(runtime?.cursor?.({ canPan: false, panning: true })).toBe("not-allowed");
  });
});

describe("viewToolRuntime", () => {
  it("has no runtime for the other tools", () => {
    expect(viewToolRuntime(toolNamed("paintbrush"), host())).toBeUndefined();
  });
});
