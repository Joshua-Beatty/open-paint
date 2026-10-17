import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ColorWheel } from "./ColorWheel";
import type { Rgba } from "./color-math";

const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 };
const BLUE: Rgba = { r: 0, g: 0, b: 255, a: 255 };

afterEach(cleanup);

describe("ColorWheel other-color nub (UI-FTW-06)", () => {
  beforeEach(() => {
    if (!HTMLElement.prototype.setPointerCapture) {
      HTMLElement.prototype.setPointerCapture = vi.fn();
    }
  });

  it("shows no second nub without an other color", () => {
    const { container } = render(<ColorWheel color={RED} onChange={vi.fn()} label="Wheel" />);

    expect(container.querySelectorAll(".color-wheel-nub")).toHaveLength(1);
    expect(container.querySelector(".is-other")).toBeNull();
  });

  it("draws the other color's nub, shown only while the wheel is dragged", () => {
    const { container } = render(
      <ColorWheel color={RED} other={BLUE} onChange={vi.fn()} label="Wheel" />,
    );
    const wheel = screen.getByRole("img", { name: "Wheel" });
    const other = container.querySelector(".is-other");

    expect(other).not.toBeNull();
    expect(other?.classList.contains("is-shown")).toBe(false);

    fireEvent.pointerDown(wheel, { pointerId: 1, clientX: 0, clientY: 0 });
    expect(other?.classList.contains("is-shown")).toBe(true);

    fireEvent.pointerUp(wheel, { pointerId: 1 });
    expect(other?.classList.contains("is-shown")).toBe(false);
  });
});
