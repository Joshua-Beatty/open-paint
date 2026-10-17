// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatNumber, parseNumberText } from "./control-math";
import { InlineSlider, type InlineSliderProps } from "./ScalarSlider";

afterEach(cleanup);

const STEPS = { small: 0.01, large: 0.05, increment: 0.01, ticks: false };

/** A slider that keeps its value, as a settings-bound control does. */
function Harness(props: Partial<InlineSliderProps> & { readonly spy: (value: number) => void }) {
  const [value, setValue] = useState(props.value ?? 0.75);
  return (
    <InlineSlider
      name="Hardness"
      range={{ min: 0, max: 1 }}
      steps={STEPS}
      decimals={0}
      percent
      disabled={false}
      {...props}
      value={value}
      onChange={(next) => {
        props.spy(next);
        setValue(next);
      }}
    />
  );
}

function renderSlider(props: Partial<InlineSliderProps> = {}) {
  const spy = vi.fn<(value: number) => void>();
  render(<Harness {...props} spy={spy} />);
  return { spy, slider: () => screen.getByRole("slider", { name: "Hardness" }) };
}

/** Gives the slider a 100 px box from x = 0, which jsdom does not lay out. */
function sizeTrack(element: HTMLElement) {
  element.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 100, height: 28, right: 100, bottom: 28 }) as DOMRect;
}

describe("InlineSlider (TL-OPT-BRUSH, TL-OPT-FLOOD)", () => {
  it("is an ARIA slider with its range and the value as text", () => {
    const { slider } = renderSlider();
    expect(slider().getAttribute("aria-valuemin")).toBe("0");
    expect(slider().getAttribute("aria-valuemax")).toBe("1");
    expect(slider().getAttribute("aria-valuenow")).toBe("0.75");
    expect(slider().getAttribute("aria-valuetext")).toBe("75%");
    expect(slider().textContent).toBe("75%");
    expect(slider().tabIndex).toBe(0);
  });

  it("steps with the arrow keys, by the large step with Ctrl or Page keys, and ends with Home and End", () => {
    const { spy, slider } = renderSlider();
    fireEvent.keyDown(slider(), { key: "ArrowRight" });
    expect(spy).toHaveBeenLastCalledWith(0.76);
    fireEvent.keyDown(slider(), { key: "ArrowLeft", ctrlKey: true });
    expect(spy).toHaveBeenLastCalledWith(0.71);
    fireEvent.keyDown(slider(), { key: "PageUp" });
    expect(spy).toHaveBeenLastCalledWith(0.76);
    fireEvent.keyDown(slider(), { key: "End" });
    expect(spy).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(slider(), { key: "Home" });
    expect(spy).toHaveBeenLastCalledWith(0);
    expect(slider().getAttribute("aria-valuetext")).toBe("0%");
  });

  it("steps with the wheel while the pointer is over it, five times further with Ctrl", () => {
    const { spy, slider } = renderSlider();
    fireEvent.wheel(slider(), { deltaY: -100 });
    expect(spy).toHaveBeenLastCalledWith(0.76);
    fireEvent.wheel(slider(), { deltaY: 100, ctrlKey: true });
    expect(spy).toHaveBeenLastCalledWith(0.71);
  });

  it("sets the value from the pointer while dragging", () => {
    const { spy, slider } = renderSlider();
    const track = slider();
    sizeTrack(track);
    track.setPointerCapture = () => undefined;
    fireEvent.pointerDown(track, { button: 0, clientX: 75, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 40, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 30, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 30, pointerId: 1 });
    expect(spy).toHaveBeenLastCalledWith(0.3);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("sets the value at most once per frame while dragging, at the newest pointer position", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames[id - 1] = () => {};
    });
    try {
      const { spy, slider } = renderSlider();
      const track = slider();
      sizeTrack(track);
      track.setPointerCapture = () => undefined;
      fireEvent.pointerDown(track, { button: 0, clientX: 75, pointerId: 1 });
      for (const clientX of [60, 50, 40]) fireEvent.pointerMove(track, { clientX, pointerId: 1 });
      expect(spy).not.toHaveBeenCalled();
      expect(frames).toHaveLength(1);
      act(() => frames[0]?.(0));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenLastCalledWith(0.4);
      expect(slider().getAttribute("aria-valuenow")).toBe("0.4");
      // The release commits a move the next frame has not drawn yet.
      fireEvent.pointerMove(track, { clientX: 20, pointerId: 1 });
      fireEvent.pointerUp(track, { clientX: 20, pointerId: 1 });
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenLastCalledWith(0.2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("opens a text box on a click, and Enter stores the typed percentage", () => {
    const { spy, slider } = renderSlider();
    const track = slider();
    track.setPointerCapture = () => undefined;
    fireEvent.pointerDown(track, { button: 0, clientX: 10, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 10, pointerId: 1 });
    const box = screen.getByRole("textbox", { name: "Hardness value" });
    expect((box as HTMLInputElement).value).toBe("75%");
    fireEvent.change(box, { target: { value: "40" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(spy).toHaveBeenLastCalledWith(0.4);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.activeElement).toBe(slider());
  });

  it("starts typing from a digit key, clamps to the range, and Escape keeps the value", () => {
    const { spy, slider } = renderSlider();
    fireEvent.keyDown(slider(), { key: "2" });
    const box = screen.getByRole("textbox", { name: "Hardness value" });
    expect((box as HTMLInputElement).value).toBe("2");
    fireEvent.change(box, { target: { value: "250 %" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(spy).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(slider(), { key: "Enter" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "10" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(slider().getAttribute("aria-valuetext")).toBe("100%");
  });

  it("ignores input while disabled", () => {
    const { spy, slider } = renderSlider({ disabled: true });
    expect(slider().getAttribute("aria-disabled")).toBe("true");
    expect(slider().tabIndex).toBe(-1);
    fireEvent.keyDown(slider(), { key: "ArrowRight" });
    fireEvent.wheel(slider(), { deltaY: -100 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("number text", () => {
  it("formats percentages and plain numbers", () => {
    expect(formatNumber(0.75, 0, true, "en-US")).toBe("75%");
    expect(formatNumber(0.155, 1, true, "en-US")).toBe("15.5%");
    expect(formatNumber(2.5, 2, false, "en-US")).toBe("2.5");
  });

  it("parses typed numbers, with or without the percent sign", () => {
    expect(parseNumberText("75", true)).toBe(0.75);
    expect(parseNumberText(" 75 % ", true)).toBe(0.75);
    expect(parseNumberText("2,5", false)).toBe(2.5);
    expect(parseNumberText("-3", false)).toBe(-3);
    expect(parseNumberText("abc", true)).toBeUndefined();
    expect(parseNumberText("", false)).toBeUndefined();
  });
});
