// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PresetComboBox, type PresetComboBoxProps } from "./PresetComboBox";

const PRESETS = [1, 2, 5, 10];

function renderBox(overrides: Partial<PresetComboBoxProps> = {}) {
  const onChange = vi.fn<(value: number) => void>();
  render(
    <PresetComboBox
      name="Brush size"
      value={2}
      range={{ min: 1, max: 20 }}
      presets={PRESETS}
      step={1}
      disabled={false}
      onChange={onChange}
      {...overrides}
    />,
  );
  return { onChange, input: screen.getByRole("combobox", { name: "Brush size" }) };
}

afterEach(() => {
  cleanup();
});

describe("PresetComboBox", () => {
  it("steps the value with the − and + buttons", () => {
    const { onChange } = renderBox();
    fireEvent.click(screen.getByRole("button", { name: "Increase" }));
    expect(onChange).toHaveBeenLastCalledWith(3);
    fireEvent.click(screen.getByRole("button", { name: "Decrease" }));
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it("commits a typed number in range on Enter", () => {
    const { onChange, input } = renderBox();
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(7);
  });

  it("refuses text that is not a number", () => {
    const { onChange, input } = renderBox();
    fireEvent.change(input, { target: { value: "wide" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Invalid number");
  });

  it("refuses a number below the minimum and above the maximum", () => {
    const { onChange, input } = renderBox();
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toBe("Size is smaller than 1");
    fireEvent.change(input, { target: { value: "21" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toBe("Size is larger than 20");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("steps with the mouse wheel over the box, five at a time with Ctrl", () => {
    const { onChange, input } = renderBox();
    const box = input.closest(".prop-field") as HTMLElement;
    const wheel = new WheelEvent("wheel", { deltaY: -100, cancelable: true, bubbles: true });
    box.dispatchEvent(wheel);
    expect(onChange).toHaveBeenLastCalledWith(3);
    expect(wheel.defaultPrevented).toBe(true);
    fireEvent.wheel(box, { deltaY: 100, ctrlKey: true });
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it("steps a whole-number size by its magnitude, on round values, with the wheel and buttons", () => {
    // The brush size range: its default step would be a fiftieth of it, 19.99.
    const range = { min: 1, max: 2000 };
    const sized = (value: number) => {
      cleanup();
      return renderBox({ value, range, step: 19.99, magnitudeSteps: true });
    };
    let { onChange, input } = sized(2);
    fireEvent.wheel(input.closest(".prop-field") as HTMLElement, { deltaY: -100 });
    expect(onChange).toHaveBeenLastCalledWith(3);
    ({ onChange, input } = sized(21));
    fireEvent.wheel(input.closest(".prop-field") as HTMLElement, { deltaY: -100 });
    expect(onChange).toHaveBeenLastCalledWith(22);
    ({ onChange, input } = sized(20));
    fireEvent.wheel(input.closest(".prop-field") as HTMLElement, { deltaY: 100 });
    expect(onChange).toHaveBeenLastCalledWith(19);
    ({ onChange, input } = sized(100));
    fireEvent.click(screen.getByRole("button", { name: "Increase" }));
    expect(onChange).toHaveBeenLastCalledWith(110);
    fireEvent.wheel(input.closest(".prop-field") as HTMLElement, { deltaY: 100, ctrlKey: true });
    expect(onChange).toHaveBeenLastCalledWith(75);
  });

  it("disables the buttons when the property is read-only", () => {
    renderBox({ disabled: true });
    expect((screen.getByRole("button", { name: "Increase" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
