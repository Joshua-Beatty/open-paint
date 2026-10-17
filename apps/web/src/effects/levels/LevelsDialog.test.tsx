/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Surface } from "@openpaint/document";
import { type EffectSource, LEVELS_IDENTITY, levelsSchema, levelsValues } from "@openpaint/effects";
import type { PropertyValues } from "@openpaint/properties";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LevelsDialog } from "./LevelsDialog";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

afterEach(cleanup);

/** A one-row source of gray pixels with alpha 255. */
function grayRow(values: readonly number[]): EffectSource {
  const data = new Uint8ClampedArray(values.length * 4);
  values.forEach((value, i) => {
    data.set([value, value, value, 255], i * 4);
  });
  return { pixels: new Surface(values.length, 1, data), coverage: undefined };
}

function renderDialog(source: EffectSource | undefined = grayRow([10, 100, 200, 250])) {
  const onValuesChange = vi.fn<(values: PropertyValues) => void>();
  const onOk = vi.fn<(values: PropertyValues) => void>();
  const onCancel = vi.fn<() => void>();
  render(
    <LevelsDialog
      title="Levels"
      schema={levelsSchema()}
      values={levelsValues(LEVELS_IDENTITY)}
      source={source}
      onValuesChange={onValuesChange}
      onOk={onOk}
      onCancel={onCancel}
    />,
  );
  return { onValuesChange, onOk, onCancel };
}

function lastValues(spy: { mock: { lastCall?: readonly [PropertyValues] } }): PropertyValues {
  const values = spy.mock.lastCall?.[0];
  if (values === undefined) throw new Error("The dialog did not preview.");
  return values;
}

function isChecked(name: string): boolean {
  return (screen.getByRole("checkbox", { name }) as HTMLInputElement).checked;
}

function isDisabled(name: string): boolean {
  return (screen.getByRole("textbox", { name }) as HTMLInputElement).disabled;
}

function x(values: PropertyValues, key: string): number {
  const value = values[key];
  if (typeof value !== "object" || value === null || !("x" in value)) {
    throw new Error(`"${key}" is not a vector.`);
  }
  return value.x;
}

describe("LevelsDialog (ADJ-LEVELS-UI)", () => {
  it("opens with its title and the R, G and B checkboxes all checked", () => {
    renderDialog();
    expect(screen.getByRole("heading", { name: "Levels Adjustment" })).toBeTruthy();
    expect(isChecked("R")).toBe(true);
    expect(isChecked("G")).toBe(true);
    expect(isChecked("B")).toBe(true);
  });

  it("previews a spinner change and sends the new value", () => {
    const { onValuesChange } = renderDialog();
    const input = screen.getByRole("textbox", { name: "Input white" });
    fireEvent.change(input, { target: { value: "200" } });
    fireEvent.blur(input);
    expect(x(lastValues(onValuesChange), "inputWhite")).toBeCloseTo(200 / 255, 6);
  });

  it("disables the spinners when no channel is checked", () => {
    renderDialog();
    for (const name of ["R", "G", "B"]) {
      fireEvent.click(screen.getByRole("checkbox", { name }));
    }
    expect(isDisabled("Input white")).toBe(true);
    expect(isDisabled("Output gamma")).toBe(true);
  });

  it("sends the current values on OK, and calls Cancel on Cancel", () => {
    const { onOk, onCancel } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onOk).toHaveBeenCalledTimes(1);
    expect(onOk.mock.lastCall?.[0]).toEqual(levelsValues(LEVELS_IDENTITY));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("restores the identity on Reset and keeps the channel mask", () => {
    const { onValuesChange } = renderDialog();
    const input = screen.getByRole("textbox", { name: "Input white" });
    fireEvent.change(input, { target: { value: "200" } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole("checkbox", { name: "G" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "G" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(lastValues(onValuesChange)).toEqual(levelsValues(LEVELS_IDENTITY));
    expect(isChecked("G")).toBe(true);
  });

  it("sets the Auto points from the pixels, with the output from 0 to 255", () => {
    const { onValuesChange } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Auto" }));
    const values = lastValues(onValuesChange);
    expect(x(values, "inputBlack")).toBeCloseTo(10 / 255, 6);
    expect(x(values, "inputWhite")).toBeCloseTo(250 / 255, 6);
    expect(x(values, "outputBlack")).toBe(0);
    expect(x(values, "outputWhite")).toBe(1);
  });

  it("opens the color picker on a double-click, and sets the point from its OK", () => {
    const { onValuesChange } = renderDialog();
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "Input Black Point (double click to choose)" }),
    );
    const picker = screen.getByRole("dialog", { name: "Choose Color" });
    const hex = within(picker).getByRole("textbox", { name: /hex/i });
    fireEvent.change(hex, { target: { value: "808080" } });
    fireEvent.blur(hex);
    fireEvent.click(within(picker).getByRole("button", { name: "OK" }));
    expect(x(lastValues(onValuesChange), "inputBlack")).toBeCloseTo(128 / 255, 6);
  });

  it("opens the color picker from the keyboard (Enter or Space), not from a single pointer click", () => {
    renderDialog();
    const swatch = screen.getByRole("button", {
      name: "Input Black Point (double click to choose)",
    });
    fireEvent.click(swatch, { detail: 1 });
    expect(screen.queryByRole("dialog", { name: "Choose Color" })).toBeNull();
    fireEvent.click(swatch, { detail: 0 });
    expect(screen.getByRole("dialog", { name: "Choose Color" })).toBeTruthy();
  });

  it("closes the color picker on Cancel without changing the point", () => {
    const { onValuesChange } = renderDialog();
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "Input Black Point (double click to choose)" }),
    );
    const picker = screen.getByRole("dialog", { name: "Choose Color" });
    fireEvent.click(within(picker).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Choose Color" })).toBeNull();
    expect(onValuesChange).not.toHaveBeenCalled();
  });
});
