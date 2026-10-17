import { describe, expect, it } from "vitest";
import { hasUnsavedImages, planClose } from "./close-flow";

describe("planClose", () => {
  it("lists every image in tab order and the unsaved ones among them", () => {
    const plan = planClose([
      { id: "a", dirty: false },
      { id: "b", dirty: true },
      { id: "c", dirty: true },
    ]);
    expect(plan.ids).toEqual(["a", "b", "c"]);
    expect(plan.dirty).toEqual(["b", "c"]);
  });

  it("has no unsaved images when every candidate is clean", () => {
    expect(planClose([{ id: "a", dirty: false }]).dirty).toEqual([]);
    expect(planClose([]).ids).toEqual([]);
  });
});

describe("hasUnsavedImages", () => {
  it("is true while any image is dirty", () => {
    expect(hasUnsavedImages([{ id: "a", dirty: false }])).toBe(false);
    expect(
      hasUnsavedImages([
        { id: "a", dirty: false },
        { id: "b", dirty: true },
      ]),
    ).toBe(true);
    expect(hasUnsavedImages([])).toBe(false);
  });
});
