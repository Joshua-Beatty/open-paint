import { shapeCategories } from "@openpaint/extension-api";
import { enUS } from "@openpaint/i18n";
import { shapeRings } from "@openpaint/tools";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHAPE_ID,
  DRAWABLE_SHAPES,
  drawableShapeOf,
  drawableShapeOrDefault,
  SHAPE_REGISTRY,
} from "./shape-catalog";

const PARAMS = { radius: 10, tailX: 0.25, tailY: 1.25 };

describe("shape catalog (TL-SHAPE-02)", () => {
  it("registers the 12 v1 shapes and the Line / Curve entry in the picker's order", () => {
    expect(shapeCategories(SHAPE_REGISTRY).map((group) => group.category)).toEqual([
      "lines",
      "basic",
      "polygons",
      "arrows",
      "callouts",
      "symbols",
    ]);
    expect(SHAPE_REGISTRY.list().map((shape) => shape.id)).toEqual([
      "line",
      "rectangle",
      "roundedRectangle",
      "ellipse",
      "diamond",
      "triangle",
      "rightTriangle",
      "pentagon",
      "hexagon",
      "star",
      "arrow",
      "callout",
      "heart",
    ]);
  });

  it("draws only the 12 shapes, and leaves the Line / Curve entry to its tool", () => {
    expect(DRAWABLE_SHAPES).toHaveLength(12);
    expect(DRAWABLE_SHAPES.some((shape) => shape.id === "line")).toBe(false);
    expect(SHAPE_REGISTRY.get("line")?.tool).toBe("lineCurve");
  });

  it("starts with Rectangle, the first in Basic", () => {
    expect(DEFAULT_SHAPE_ID).toBe("rectangle");
    expect(DRAWABLE_SHAPES.find((shape) => shape.category === "basic")?.id).toBe("rectangle");
  });

  it("gives every outline a path that draws a closed ring with an area", () => {
    for (const shape of DRAWABLE_SHAPES) {
      const rings = shapeRings(shape.geometry.path, { x: 0, y: 0, width: 100, height: 60 }, PARAMS);
      expect(rings, shape.id).toHaveLength(1);
      expect(rings[0]?.length, shape.id).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps each outline inside the unit square, except the callout tail", () => {
    for (const shape of DRAWABLE_SHAPES) {
      if (shape.id === "callout") continue;
      const rings = shapeRings(shape.geometry.path, { x: 0, y: 0, width: 100, height: 60 }, PARAMS);
      for (const point of rings[0] ?? []) {
        expect(point.x, shape.id).toBeGreaterThanOrEqual(-1e-6);
        expect(point.x, shape.id).toBeLessThanOrEqual(100 + 1e-6);
        expect(point.y, shape.id).toBeGreaterThanOrEqual(-1e-6);
        expect(point.y, shape.id).toBeLessThanOrEqual(60 + 1e-6);
      }
    }
  });

  it("gives the polygons and the star their natural aspect ratio, and the rest 1:1", () => {
    expect(SHAPE_REGISTRY.get("pentagon")?.geometry.aspect).toBeCloseTo(1.0515, 3);
    expect(SHAPE_REGISTRY.get("hexagon")?.geometry.aspect).toBeCloseTo(0.866, 3);
    expect(SHAPE_REGISTRY.get("star")?.geometry.aspect).toBeCloseTo(1.0515, 3);
    expect(SHAPE_REGISTRY.get("rectangle")?.geometry.aspect).toBeUndefined();
  });

  it("gives the rounded shapes a corner size setting, and the callout a tail handle", () => {
    for (const id of ["roundedRectangle", "callout"]) {
      const shape = SHAPE_REGISTRY.get(id);
      expect(shape?.settings.properties.map((property) => property.key)).toEqual(["shapes.radius"]);
      expect(shape?.handles).toContain("radius");
    }
    expect(SHAPE_REGISTRY.get("callout")?.handles).toEqual(["radius", "tail"]);
    expect(SHAPE_REGISTRY.get("rectangle")?.settings.properties).toEqual([]);
  });

  it("has an English label for every shape and picker group", () => {
    for (const shape of SHAPE_REGISTRY.list()) {
      expect(enUS[shape.label], shape.id).toBeDefined();
    }
    for (const group of shapeCategories(SHAPE_REGISTRY)) {
      expect(
        enUS[`shape.category.${group.category}` as keyof typeof enUS],
        group.category,
      ).toBeDefined();
    }
  });

  it("reads the stored shape type, and falls back to Rectangle for an unknown one", () => {
    expect(drawableShapeOf({ name: "ellipse" })?.id).toBe("ellipse");
    expect(drawableShapeOf({ name: "line" })).toBeUndefined();
    expect(drawableShapeOf("ellipse")).toBeUndefined();
    expect(drawableShapeOrDefault({ name: "nope" }).id).toBe("rectangle");
  });
});
