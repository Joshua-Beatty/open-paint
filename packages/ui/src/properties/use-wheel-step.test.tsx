// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NumberBox } from "./ScalarSlider";
import { WheelStepper, wheelDeltaPx } from "./use-wheel-step";

afterEach(cleanup);

describe("wheelDeltaPx", () => {
  it("reads the vertical delta first, then the horizontal one, in px", () => {
    expect(wheelDeltaPx({ deltaX: 0, deltaY: -100, deltaMode: 0 })).toBe(-100);
    expect(wheelDeltaPx({ deltaX: 100, deltaY: 0, deltaMode: 0 })).toBe(100);
    expect(wheelDeltaPx({ deltaX: 0, deltaY: 3, deltaMode: 1 })).toBe(100);
  });
});

describe("WheelStepper", () => {
  it("steps once per mouse notch, up for a negative delta", () => {
    const stepper = new WheelStepper();
    expect(stepper.steps(-100)).toBe(1);
    expect(stepper.steps(120)).toBe(-1);
  });

  it("adds small trackpad deltas up to a notch", () => {
    const stepper = new WheelStepper();
    expect(stepper.steps(-40)).toBe(0);
    expect(stepper.steps(-40)).toBe(0);
    expect(stepper.steps(-40)).toBe(1);
    expect(stepper.steps(-40)).toBe(0);
  });
});

describe("NumberBox wheel stepping", () => {
  it("steps the value while the pointer is over the field, without focus", () => {
    const onChange = vi.fn<(value: number) => void>();
    render(
      <NumberBox
        name="Hardness"
        value={0.5}
        range={{ min: 0, max: 1 }}
        step={0.01}
        decimals={2}
        disabled={false}
        onChange={onChange}
      />,
    );
    const field = screen.getByRole("group");
    fireEvent.wheel(field, { deltaY: -100 });
    expect(onChange).toHaveBeenLastCalledWith(0.51);
    fireEvent.wheel(field, { deltaY: 100, ctrlKey: true });
    expect(onChange).toHaveBeenLastCalledWith(0.45);
  });

  it("ignores the wheel while disabled", () => {
    const onChange = vi.fn<(value: number) => void>();
    render(
      <NumberBox
        name="Hardness"
        value={0.5}
        range={{ min: 0, max: 1 }}
        step={0.01}
        decimals={2}
        disabled
        onChange={onChange}
      />,
    );
    fireEvent.wheel(screen.getByRole("group"), { deltaY: -100 });
    expect(onChange).not.toHaveBeenCalled();
  });
});
