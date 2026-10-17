import { EXTENSION_API_MAJOR, type ShapeDescriptor } from "@openpaint/extension-api";
import type { MessageId } from "@openpaint/i18n";
import { definePropertySchema } from "@openpaint/properties";
import { describe, expect, it } from "vitest";
import { SHAPE_REGISTRY } from "./shape-catalog";
import { shapeIcon } from "./shape-icons";

/** Every coordinate of a path made of M, L and Z commands. */
function coordinates(path: string): number[] {
  return (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

describe("shapeIcon (TL-SHAPE-02)", () => {
  it("draws an icon for every registered shape, inside the 16 px grid and filling it", () => {
    const shapes = SHAPE_REGISTRY.list();
    expect(shapes.length).toBeGreaterThan(10);
    for (const shape of shapes) {
      const icon = shapeIcon(shape);
      expect(icon, shape.id).toMatch(/^M[\d. L]+/);
      const values = coordinates(icon);
      expect(Math.min(...values), shape.id).toBeGreaterThanOrEqual(2 - 0.01);
      expect(Math.max(...values), shape.id).toBeLessThanOrEqual(14 + 0.01);
      // The longer side spans the 12 px between the margins.
      const xs = values.filter((_, index) => index % 2 === 0);
      const ys = values.filter((_, index) => index % 2 === 1);
      const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      expect(span, shape.id).toBeCloseTo(12, 1);
    }
  });

  it("gives every shape its own outline", () => {
    const icons = SHAPE_REGISTRY.list().map(shapeIcon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("closes the outline of a closed shape and leaves a line open", () => {
    const rectangle = SHAPE_REGISTRY.get("rectangle");
    const line = SHAPE_REGISTRY.get("line");
    if (rectangle === undefined || line === undefined) throw new Error("missing shapes");
    expect(shapeIcon(rectangle)).toBe("M2 2L14 2L14 14L2 14Z");
    expect(shapeIcon(line)).toBe("M2 14L14 2");
  });

  it("draws a newly registered shape from its geometry, handles included", () => {
    const shape: ShapeDescriptor = {
      id: "test.notch",
      apiVersion: EXTENSION_API_MAJOR,
      label: "shape.rectangle" as MessageId,
      category: "basic",
      geometry: {
        path: "M {radius.x},0 L 1,0 L 1,1 L 0,1 L 0,{radius.y} Z",
        fillRule: "nonzero",
        aspect: 2,
      },
      settings: definePropertySchema({ properties: [] }),
      handles: ["radius"],
    };
    const icon = shapeIcon(shape);
    // Twice as wide as tall: 12 x 6 px, centered, with the notch a quarter of the height.
    expect(icon).toBe("M3.5 5L14 5L14 11L2 11L2 6.5Z");
  });
});
