import { CURVE_IDENTITY, type CurveList } from "@openpaint/effects";
import { describe, expect, it } from "vitest";
import {
  type CurveEditState,
  type CurveKey,
  curveAt,
  dragCurves,
  editableKeys,
  hoverPoint,
  modeKeys,
  nearestPoint,
  pressCurves,
  removePoints,
  resetMode,
} from "./curves-model";

type Lists = Readonly<Record<CurveKey, CurveList>>;

const IDENTITY_LISTS: Lists = {
  luminosity: CURVE_IDENTITY,
  red: CURVE_IDENTITY,
  green: CURVE_IDENTITY,
  blue: CURVE_IDENTITY,
};

const RGB_KEYS: readonly CurveKey[] = ["red", "green", "blue"];

function withRed(red: CurveList): Lists {
  return { ...IDENTITY_LISTS, red };
}

function state(overrides: Partial<CurveEditState> = {}): CurveEditState {
  return {
    mode: "rgb",
    lists: IDENTITY_LISTS,
    checked: { red: true, green: true, blue: true },
    ...overrides,
  };
}

describe("curve coordinates (ADJ-CURVES-UI-05)", () => {
  it("maps the plot corners to the curve corners", () => {
    expect(curveAt(0, 0, 256, 256)).toEqual([0, 255]);
    expect(curveAt(255, 255, 256, 256)).toEqual([255, 0]);
  });

  it("clamps positions outside the plot", () => {
    expect(curveAt(-20, 400, 256, 256)).toEqual([0, 0]);
    expect(curveAt(400, -20, 256, 256)).toEqual([255, 255]);
  });
});

describe("hit testing (ADJ-CURVES-UI-07)", () => {
  it("finds a point within a squared distance of 30 and nothing beyond", () => {
    const list: CurveList = [[10, 10]];
    expect(nearestPoint(list, 13, 13)).toBe(0);
    expect(nearestPoint(list, 14, 14)).toBeUndefined();
  });

  it("reports the hovered point of the nearest curve", () => {
    const lists = withRed([
      [0, 0],
      [100, 100],
      [255, 255],
    ]);
    expect(hoverPoint(lists, RGB_KEYS, 101, 99)).toEqual({ key: "red", x: 100 });
    expect(hoverPoint(lists, ["green"], 101, 99)).toBeUndefined();
  });
});

describe("editable curves (ADJ-CURVES-UI-02, -03)", () => {
  it("lists the curves of each mode", () => {
    expect(modeKeys("luminosity")).toEqual(["luminosity"]);
    expect(modeKeys("rgb")).toEqual(["red", "green", "blue"]);
  });

  it("lets only the checked RGB channels be edited, and always the luminosity curve", () => {
    expect(editableKeys(state({ checked: { red: false, green: true, blue: false } }))).toEqual([
      "green",
    ]);
    expect(editableKeys(state({ mode: "luminosity" }))).toEqual(["luminosity"]);
    expect(editableKeys(state({ checked: { red: false, green: false, blue: false } }))).toEqual([]);
  });
});

describe("press and drag (ADJ-CURVES-UI-08)", () => {
  it("creates a point at the press in every editable curve on empty space", () => {
    const { lists } = pressCurves(IDENTITY_LISTS, RGB_KEYS, 100, 50);
    for (const key of RGB_KEYS) {
      expect(lists[key]).toEqual([
        [0, 0],
        [100, 50],
        [255, 255],
      ]);
    }
    expect(lists.luminosity).toEqual(CURVE_IDENTITY);
  });

  it("picks up an interior point and places it at the pointer, in the curves that had one", () => {
    const red: CurveList = [
      [0, 0],
      [128, 128],
      [255, 255],
    ];
    const pressed = pressCurves(withRed(red), RGB_KEYS, 130, 126);
    expect(pressed.lists.red).toEqual([
      [0, 0],
      [130, 126],
      [255, 255],
    ]);
    expect(pressed.lists.green).toEqual(CURVE_IDENTITY);
  });

  it("moves the dragged point and removes its old column", () => {
    const red: CurveList = [
      [0, 0],
      [128, 128],
      [255, 255],
    ];
    const pressed = pressCurves(withRed(red), ["red"], 130, 126);
    const dragged = dragCurves(pressed.lists, pressed.drag, 50, 200);
    expect(dragged.lists.red).toEqual([
      [0, 0],
      [50, 200],
      [255, 255],
    ]);
  });

  it("overwrites a passed point only temporarily, and restores it when the drag moves off", () => {
    const red: CurveList = [
      [0, 0],
      [60, 60],
      [128, 128],
      [255, 255],
    ];
    const pressed = pressCurves(withRed(red), ["red"], 60, 60);
    const over = dragCurves(pressed.lists, pressed.drag, 128, 90);
    expect(over.lists.red).toEqual([
      [0, 0],
      [128, 90],
      [255, 255],
    ]);
    const off = dragCurves(over.lists, over.drag, 200, 200);
    expect(off.lists.red).toEqual([
      [0, 0],
      [128, 128],
      [200, 200],
      [255, 255],
    ]);
  });

  it("keeps an end point's column and sets its height when dragged vertically", () => {
    const pressed = pressCurves(IDENTITY_LISTS, ["luminosity"], 0, 0);
    const dragged = dragCurves(pressed.lists, pressed.drag, 0, 120);
    expect(dragged.lists.luminosity).toEqual([
      [0, 120],
      [255, 255],
    ]);
  });

  it("creates an interior point when an end point is dragged horizontally", () => {
    const pressed = pressCurves(IDENTITY_LISTS, ["luminosity"], 0, 0);
    const moved = dragCurves(pressed.lists, pressed.drag, 0, 120);
    const away = dragCurves(moved.lists, moved.drag, 40, 120);
    expect(away.lists.luminosity).toEqual([
      [0, 120],
      [40, 120],
      [255, 255],
    ]);
  });

  it("does not change the curves that the press did not hit", () => {
    const red: CurveList = [
      [0, 0],
      [128, 128],
      [255, 255],
    ];
    const pressed = pressCurves(withRed(red), RGB_KEYS, 130, 126);
    expect(pressed.lists.blue).toEqual(CURVE_IDENTITY);
    expect(pressed.drag.map((channel) => channel.key)).toEqual(["red"]);
  });
});

describe("removing points (ADJ-CURVES-UI-09)", () => {
  it("removes an interior point from each editable curve that has one", () => {
    const lists = {
      ...IDENTITY_LISTS,
      luminosity: [
        [0, 0],
        [100, 100],
        [255, 255],
      ] as CurveList,
    };
    const next = removePoints(lists, ["luminosity"], 101, 99);
    expect(next.luminosity).toEqual(CURVE_IDENTITY);
  });

  it("never removes an end point", () => {
    const next = removePoints(IDENTITY_LISTS, RGB_KEYS, 0, 0);
    expect(next.red).toEqual(CURVE_IDENTITY);
    expect(removePoints(IDENTITY_LISTS, RGB_KEYS, 255, 255).blue).toEqual(CURVE_IDENTITY);
  });

  it("leaves a checked-off curve alone", () => {
    const lists = withRed([
      [0, 0],
      [100, 100],
      [255, 255],
    ]);
    expect(removePoints(lists, ["green"], 100, 100).red).toEqual(lists.red);
  });
});

describe("reset (ADJ-CURVES-UI-10)", () => {
  it("restores the visible mode's curves to the identity and keeps the other mode's", () => {
    const edited = {
      luminosity: [
        [0, 0],
        [50, 90],
        [255, 255],
      ] as CurveList,
      red: [
        [0, 0],
        [50, 90],
        [255, 255],
      ] as CurveList,
      green: CURVE_IDENTITY,
      blue: CURVE_IDENTITY,
    };
    expect(resetMode(edited, "rgb")).toMatchObject({
      luminosity: edited.luminosity,
      red: CURVE_IDENTITY,
    });
    expect(resetMode(edited, "luminosity").luminosity).toEqual(CURVE_IDENTITY);
  });
});
