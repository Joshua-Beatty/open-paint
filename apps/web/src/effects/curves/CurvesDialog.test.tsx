/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import {
  CURVE_IDENTITY,
  type CurveList,
  curvesParams,
  curvesSchema,
  curvesValues,
} from "@openpaint/effects";
import type { PropertyValues } from "@openpaint/properties";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CurvesDialog } from "./CurvesDialog";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

afterEach(cleanup);

const BENT: CurveList = [
  [0, 0],
  [100, 60],
  [255, 255],
];

function renderDialog(values: PropertyValues) {
  const onValuesChange = vi.fn<(values: PropertyValues) => void>();
  const onOk = vi.fn<(values: PropertyValues) => void>();
  const onCancel = vi.fn<() => void>();
  render(
    <CurvesDialog
      title="Curves"
      schema={curvesSchema()}
      values={values}
      source={undefined}
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

describe("CurvesDialog (ADJ-CURVES-UI)", () => {
  it("opens in Luminosity mode with one disabled, checked curve checkbox and the OK button focused", () => {
    renderDialog(curvesValues(curvesParams({})));
    expect(screen.getByRole("img", { name: "Curve editor" })).toBeTruthy();
    const luminosity = screen.getByRole("checkbox", { name: "Luminosity" }) as HTMLInputElement;
    expect(luminosity.checked).toBe(true);
    expect(luminosity.disabled).toBe(true);
    expect(screen.queryByRole("checkbox", { name: "Red" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "OK" }));
  });

  /** The drawn curves as lists of [x, y] plot points. */
  function drawnCurves(): [number, number][][] {
    return [...document.querySelectorAll("polyline")].map((line) =>
      (line.getAttribute("points") ?? "")
        .split(" ")
        .map((pair) => pair.split(",").map(Number) as [number, number]),
    );
  }

  /** Whether a drawn curve runs along the plot's diagonal, bottom-left to top-right. */
  function isDiagonal(points: readonly [number, number][]): boolean {
    const span = points.at(-1)?.[0] ?? 0;
    return (
      points.length === 256 &&
      span > 0 &&
      points.every(([x, y]) => Math.abs(y - (span - x)) < 0.5 + span / 255)
    );
  }

  it.each(["luminosity", "rgb"] as const)(
    "draws the default %s curves as the identity diagonal",
    (mode) => {
      renderDialog(curvesValues({ ...curvesParams({}), mode }));
      const curves = drawnCurves();
      expect(curves).toHaveLength(mode === "rgb" ? 3 : 1);
      for (const curve of curves) expect(isDiagonal(curve)).toBe(true);
    },
  );

  it("draws a remembered curve through its points and the identity again after Reset", () => {
    renderDialog(
      curvesValues({
        mode: "luminosity",
        luminosity: BENT,
        red: CURVE_IDENTITY,
        green: CURVE_IDENTITY,
        blue: CURVE_IDENTITY,
      }),
    );
    const [bent = []] = drawnCurves();
    const span = bent.at(-1)?.[0] ?? 0;
    // The curve passes through (100, 60): its plot point at column 100 sits at output 60.
    const [, y100 = 0] = bent[100] ?? [];
    expect(Math.abs(y100 - (span - (60 * span) / 255))).toBeLessThan(1);
    expect(isDiagonal(bent)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(isDiagonal(drawnCurves()[0] ?? [])).toBe(true);
  });

  it("applies a drag once per frame at the newest pointer position (L1)", () => {
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    try {
      const { onValuesChange } = renderDialog(curvesValues(curvesParams({})));
      const plot = screen.getByRole("img", { name: "Curve editor" });
      plot.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 256, height: 256, right: 256, bottom: 256 }) as DOMRect;
      fireEvent.pointerDown(plot, { button: 0, clientX: 128, clientY: 128, pointerId: 1 });
      const pressed = onValuesChange.mock.calls.length;
      for (const y of [120, 110, 100, 90]) {
        fireEvent.pointerMove(plot, { clientX: 128, clientY: y, pointerId: 1 });
      }
      expect(onValuesChange.mock.calls.length).toBe(pressed);
      act(() => {
        for (const frame of frames.splice(0)) frame(0);
      });
      expect(onValuesChange.mock.calls.length).toBe(pressed + 1);
      // The point sits where the pointer ended up: y 90 px is level ⌊255.5 − 90·255/255⌋ = 165.
      expect(lastValues(onValuesChange).luminosity).toBe("0,0 128,165 255,255");
    } finally {
      raf.mockRestore();
    }
  });

  it("shows the RGB channels, all checked, when the stored mode is RGB", () => {
    renderDialog(curvesValues({ ...curvesParams({}), mode: "rgb" }));
    expect(isChecked("Red")).toBe(true);
    expect(isChecked("Green")).toBe(true);
    expect(isChecked("Blue")).toBe(true);
  });

  it("previews the change of a checkbox and keeps the other channels", () => {
    const { onValuesChange } = renderDialog(curvesValues({ ...curvesParams({}), mode: "rgb" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Red" }));
    expect(isChecked("Red")).toBe(false);
    expect(isChecked("Green")).toBe(true);
    expect(lastValues(onValuesChange)).toMatchObject({ mode: "rgb" });
  });

  it("resets the visible curves to the identity and previews them", () => {
    const { onValuesChange } = renderDialog(
      curvesValues({
        mode: "luminosity",
        luminosity: BENT,
        red: CURVE_IDENTITY,
        green: CURVE_IDENTITY,
        blue: CURVE_IDENTITY,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(lastValues(onValuesChange)).toMatchObject({ luminosity: "0,0 255,255" });
  });

  it("submits the current values on OK", () => {
    const { onOk, onValuesChange } = renderDialog(
      curvesValues({
        mode: "luminosity",
        luminosity: BENT,
        red: CURVE_IDENTITY,
        green: CURVE_IDENTITY,
        blue: CURVE_IDENTITY,
      }),
    );
    expect(onValuesChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onOk).toHaveBeenCalledWith({
      mode: "luminosity",
      luminosity: "0,0 100,60 255,255",
      red: "0,0 255,255",
      green: "0,0 255,255",
      blue: "0,0 255,255",
    });
  });

  it("cancels without committing", () => {
    const { onCancel, onOk } = renderDialog(curvesValues({ ...curvesParams({}) }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onOk).not.toHaveBeenCalled();
  });
});
