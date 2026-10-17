import { describe, expect, it } from "vitest";
import {
  type Bodies,
  clampRightWidth,
  DEFAULT_PANEL_LAYOUT,
  effectiveRightWidth,
  isSplitterMovable,
  moveSplitter,
  type PanelLayout,
  ratiosFromBodies,
  rightBodies,
  splitRatiosFor,
} from "./panel-layout";

/** Height of the right sidebar in the tests: 600 px leaves 514 px for panel bodies. */
const TOTAL = 600;

function withLayout(overrides: Partial<PanelLayout>): PanelLayout {
  return { ...DEFAULT_PANEL_LAYOUT, ...overrides };
}

/** Floor rounding can move a value by a pixel, so compare within one. */
function expectNear(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
}

describe("rightBodies (UI-FTW-01 default split and minimums)", () => {
  it("keeps Colors at its content height and splits the rest 70/30", () => {
    expect(rightBodies(DEFAULT_PANEL_LAYOUT, TOTAL)).toEqual({
      colors: 180,
      layers: 233,
      history: 101,
    });
  });

  it("fills the space exactly with the bodies", () => {
    const bodies = rightBodies(DEFAULT_PANEL_LAYOUT, TOTAL);
    expect(bodies.colors + bodies.layers + bodies.history).toBe(514);
  });

  it("keeps every minimum when the sidebar is too short, so it overflows", () => {
    expect(rightBodies(DEFAULT_PANEL_LAYOUT, 300)).toEqual({
      colors: 180,
      layers: 120,
      history: 96,
    });
  });

  it("gives a collapsed panel's space to the others", () => {
    expect(
      rightBodies(
        withLayout({ collapsed: { ...DEFAULT_PANEL_LAYOUT.collapsed, layers: true } }),
        TOTAL,
      ),
    ).toEqual({
      colors: 180,
      layers: 0,
      history: 334,
    });
  });

  it("gives a hidden panel's space to the others and drops its header", () => {
    const layout = withLayout({
      visible: { tools: true, colors: false, layers: true, history: false },
    });
    expect(rightBodies(layout, TOTAL)).toEqual({ colors: 0, layers: 574, history: 0 });
  });

  it("uses the stored shares once they exist", () => {
    expect(rightBodies(withLayout({ splitRatios: [0.5, 0.25, 0.25] }), TOTAL)).toEqual({
      colors: 257,
      layers: 128,
      history: 129,
    });
  });

  it("raises a stored share to the minimum when it is too small", () => {
    const bodies = rightBodies(withLayout({ splitRatios: [0.05, 0.6, 0.35] }), TOTAL);
    expect(bodies.colors).toBe(180);
    expect(bodies.layers + bodies.history).toBe(334);
  });

  it("returns zero heights when every panel is hidden or collapsed", () => {
    const layout = withLayout({
      visible: { tools: true, colors: false, layers: false, history: false },
    });
    expect(rightBodies(layout, TOTAL)).toEqual({ colors: 0, layers: 0, history: 0 });
  });
});

describe("ratiosFromBodies", () => {
  it("stores the open panels' shares of their total, summing to 1", () => {
    const bodies: Bodies = { colors: 180, layers: 233, history: 101 };
    const ratios = ratiosFromBodies(bodies, DEFAULT_PANEL_LAYOUT);
    expect(ratios.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10);
    expect(ratios[0]).toBeCloseTo(180 / 514, 10);
    expect(ratios[1]).toBeCloseTo(233 / 514, 10);
  });

  it("keeps a hidden or collapsed panel's stored share", () => {
    const layout = withLayout({
      collapsed: { ...DEFAULT_PANEL_LAYOUT.collapsed, layers: true },
      splitRatios: [0.5, 0.25, 0.25],
    });
    const ratios = ratiosFromBodies({ colors: 200, layers: 0, history: 300 }, layout);
    expect(ratios[0]).toBeCloseTo(0.3, 10);
    expect(ratios[1]).toBeCloseTo(0.25, 10);
    expect(ratios[2]).toBeCloseTo(0.45, 10);
  });

  it("round-trips through rightBodies", () => {
    const layout = withLayout({ splitRatios: [0.3, 0.45, 0.25] });
    const bodies = rightBodies(layout, TOTAL);
    const again = rightBodies(withLayout({ splitRatios: ratiosFromBodies(bodies, layout) }), TOTAL);
    expect(again).toEqual(bodies);
  });
});

describe("moveSplitter", () => {
  const bodies: Bodies = { colors: 180, layers: 233, history: 101 };

  it("moves the boundary by the drag distance", () => {
    expect(moveSplitter(bodies, "layers", "history", -20, false)).toEqual({
      colors: 180,
      layers: 213,
      history: 121,
    });
  });

  it("stops the lower panel at its minimum", () => {
    expect(moveSplitter(bodies, "layers", "history", 50, false)).toEqual({
      colors: 180,
      layers: 238,
      history: 96,
    });
  });

  it("stops the upper panel at its minimum", () => {
    expect(moveSplitter(bodies, "layers", "history", -1000, false)).toEqual({
      colors: 180,
      layers: 120,
      history: 214,
    });
  });

  it("keeps the pair's total unchanged", () => {
    const moved = moveSplitter(bodies, "layers", "history", 37, false);
    expect(moved.layers + moved.history).toBe(334);
  });
});

describe("expanded Colors (UI-FTW-06)", () => {
  const expanded = (overrides: Partial<PanelLayout> = {}) =>
    withLayout({ colorsExpanded: true, ...overrides });

  it("takes its editor's height and leaves the rest to Layers and History", () => {
    // A 1080 px window leaves a 903 px sidebar: 817 px for bodies.
    const bodies = rightBodies(expanded(), 903);
    expect(bodies.colors).toBe(397);
    expect(bodies.layers + bodies.history).toBe(817 - 397);
    expect(bodies.layers).toBeGreaterThan(bodies.history);
  });

  it("squashes Layers and History to their minimums when that is what it needs", () => {
    // A 900 px window leaves a 723 px sidebar: 637 px for bodies.
    expect(rightBodies(expanded(), 723)).toEqual({ colors: 397, layers: 144, history: 96 });
  });

  it("scrolls inside, never pushing Layers and History below their minimums", () => {
    // A 768 px window leaves a 591 px sidebar: 505 px for bodies.
    expect(rightBodies(expanded(), 591)).toEqual({ colors: 289, layers: 120, history: 96 });
  });

  it("does not shrink below its compact height", () => {
    expect(rightBodies(expanded(), 300)).toEqual({ colors: 180, layers: 120, history: 96 });
  });

  it("takes more room when another panel is collapsed", () => {
    const layout = expanded({ collapsed: { ...DEFAULT_PANEL_LAYOUT.collapsed, layers: true } });
    expect(rightBodies(layout, 591)).toEqual({ colors: 397, layers: 0, history: 108 });
  });

  it("leaves the stored shares alone, so compacting restores the earlier heights", () => {
    const stored = withLayout({ splitRatios: [0.25, 0.45, 0.3] });
    const before = rightBodies(stored, 723);
    expect(rightBodies({ ...stored, colorsExpanded: true }, 723).colors).toBe(397);
    expect(rightBodies({ ...stored, colorsExpanded: false }, 723)).toEqual(before);
  });

  it("keeps its splitter still, and the one between Layers and History moves", () => {
    expect(isSplitterMovable(expanded(), "colors", "layers")).toBe(false);
    expect(isSplitterMovable(expanded(), "layers", "history")).toBe(true);
    expect(isSplitterMovable(DEFAULT_PANEL_LAYOUT, "colors", "layers")).toBe(true);
  });

  it("stores a drag between Layers and History as compact shares", () => {
    const layout = expanded();
    const bodies = rightBodies(layout, 903);
    const moved = moveSplitter(bodies, "layers", "history", -100, true);
    const ratios = splitRatiosFor(moved, layout, 903);
    const compact = rightBodies(withLayout({ splitRatios: ratios }), 903);
    expectNear(compact.colors, 180);
    expectNear(compact.layers / compact.history, moved.layers / moved.history);
    const again = rightBodies(expanded({ splitRatios: ratios }), 903);
    expectNear(again.colors, 397);
    expectNear(again.layers, moved.layers);
  });
});
describe("right sidebar width (UI-FTW-08)", () => {
  it("clamps the stored width to 220 to 480 CSS px", () => {
    expect(clampRightWidth(100)).toBe(220);
    expect(clampRightWidth(900)).toBe(480);
    expect(clampRightWidth(300.4)).toBe(300);
  });

  it("falls back to the default width for a value that is not a number", () => {
    expect(clampRightWidth(Number.NaN)).toBe(280);
  });

  it("uses the minimum below 1280 CSS px and keeps the stored width for later", () => {
    expect(effectiveRightWidth(400, 1000)).toBe(220);
    expect(effectiveRightWidth(400, 1280)).toBe(400);
    expect(effectiveRightWidth(500, 1500)).toBe(480);
  });
});
