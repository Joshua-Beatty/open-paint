// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DialogTitleBar } from "./DialogTitleBar";
import { forgetDialogOffsets } from "./dialog-drag";

/** A 300 px wide dialog centred in a 1024x768 window, with a 40 px title bar. */
const FRAME = { left: 362, top: 200, width: 300, height: 200 };
const BAR_HEIGHT = 40;

function translation(element: HTMLElement): { x: number; y: number } {
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(element.style.transform);
  return match === null ? { x: 0, y: 0 } : { x: Number(match[1]), y: Number(match[2]) };
}

/** Lays the frame and its title bar out where the frame's transform puts them, like a browser. */
function layOut(this: HTMLElement): DOMRect {
  const frame = this.closest<HTMLElement>(".modal");
  if (frame === null) return new DOMRect();
  const { x, y } = translation(frame);
  const height = this === frame ? FRAME.height : BAR_HEIGHT;
  return new DOMRect(FRAME.left + x, FRAME.top + y, FRAME.width, height);
}

function renderBar(onClose = vi.fn(), title = "Gaussian Blur") {
  const result = render(
    <div className="modal">
      <DialogTitleBar title={title} onClose={onClose} />
    </div>,
  );
  const frame = result.container.querySelector<HTMLElement>(".modal");
  const bar = result.container.querySelector<HTMLElement>(".modal-header");
  if (frame === null || bar === null) throw new Error("no title bar");
  return { ...result, frame, bar };
}

function drag(bar: HTMLElement, from: { x: number; y: number }, by: { x: number; y: number }) {
  fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: from.x, clientY: from.y });
  fireEvent.pointerMove(bar, {
    pointerId: 1,
    clientX: from.x + by.x / 2,
    clientY: from.y + by.y / 2,
  });
  fireEvent.pointerMove(bar, { pointerId: 1, clientX: from.x + by.x, clientY: from.y + by.y });
  fireEvent.pointerUp(bar, { pointerId: 1, clientX: from.x + by.x, clientY: from.y + by.y });
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(layOut);
});

afterEach(() => {
  cleanup();
  forgetDialogOffsets();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DialogTitleBar dragging", () => {
  it("moves the dialog by the drag, once per frame, without moving it per pointer event", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const { frame, bar } = renderBar();
    fireEvent.pointerDown(bar, { pointerId: 1, button: 0, clientX: 400, clientY: 210 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 300, clientY: 250 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 100, clientY: 310 });
    expect(frame.style.transform).toBe("");
    expect(frames).toHaveLength(1);
    frames[0]?.(0);
    expect(translation(frame)).toEqual({ x: -300, y: 100 });
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 100, clientY: 310 });
    expect(translation(frame)).toEqual({ x: -300, y: 100 });
  });

  it("keeps the title bar reachable when dragged off screen", () => {
    const { frame, bar } = renderBar();
    drag(bar, { x: 400, y: 210 }, { x: -3000, y: -3000 });
    // 96 px of the bar stay inside the left edge, and its top stays inside the top edge.
    expect(translation(frame)).toEqual({ x: 96 - (FRAME.left + FRAME.width), y: -FRAME.top });
    drag(bar, { x: 40, y: 10 }, { x: 5000, y: 5000 });
    expect(translation(frame)).toEqual({
      x: 1024 - 96 - FRAME.left,
      y: 768 - FRAME.top - BAR_HEIGHT,
    });
  });

  it("does not drag from the close button, which still closes", () => {
    const onClose = vi.fn();
    const { frame, bar } = renderBar(onClose);
    const close = bar.querySelector("button");
    if (close === null) throw new Error("no close button");
    drag(close, { x: 640, y: 210 }, { x: -200, y: 50 });
    expect(frame.style.transform).toBe("");
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalled();
  });

  it("ignores buttons other than the primary one", () => {
    const { frame, bar } = renderBar();
    fireEvent.pointerDown(bar, { pointerId: 1, button: 2, clientX: 400, clientY: 210 });
    fireEvent.pointerMove(bar, { pointerId: 1, clientX: 100, clientY: 310 });
    fireEvent.pointerUp(bar, { pointerId: 1, clientX: 100, clientY: 310 });
    expect(frame.style.transform).toBe("");
  });

  it("reopens the same dialog where it was left, and double-click centres it again", () => {
    const first = renderBar();
    drag(first.bar, { x: 400, y: 210 }, { x: -300, y: 100 });
    first.unmount();

    const other = renderBar(vi.fn(), "Levels");
    expect(other.frame.style.transform).toBe("");
    other.unmount();

    const again = renderBar();
    expect(translation(again.frame)).toEqual({ x: -300, y: 100 });
    fireEvent.doubleClick(again.bar);
    expect(again.frame.style.transform).toBe("");
    again.unmount();

    expect(renderBar().frame.style.transform).toBe("");
  });

  it("reopens centred when the remembered place is off screen after the window shrank", () => {
    const first = renderBar();
    drag(first.bar, { x: 400, y: 210 }, { x: 300, y: 400 });
    expect(translation(first.frame)).toEqual({ x: 300, y: 400 });
    first.unmount();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 });
    expect(renderBar().frame.style.transform).toBe("");
  });

  it("pulls an open dialog back on screen when the window shrinks", () => {
    const { frame, bar } = renderBar();
    drag(bar, { x: 400, y: 210 }, { x: 300, y: 400 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 });
    fireEvent(window, new Event("resize"));
    expect(translation(frame)).toEqual({ x: 300, y: 500 - FRAME.top - BAR_HEIGHT });
  });
});
