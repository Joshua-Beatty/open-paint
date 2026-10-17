import { enUS } from "@openpaint/i18n";
import type { SettingsStore } from "@openpaint/storage";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TOOL_REGISTRY } from "./roster";
import { SHAPE_REGISTRY } from "./shape-catalog";
import { shapeIcon } from "./shape-icons";
import { ToolOptionsStrip } from "./ToolOptionsStrip";

afterEach(cleanup);

function storeWith(values: Record<string, unknown>): SettingsStore {
  return {
    get: (path: string) => values[path],
    set: (path: string, value: unknown) => {
      values[path] = value;
    },
    onChange: () => () => undefined,
  } as unknown as SettingsStore;
}

const dashLabel = enUS["settings.field.tool.dashStyle"];
const radiusLabel = enUS["settings.field.tool.radius"];

function renderShapes(values: Record<string, unknown>) {
  const tool = TOOL_REGISTRY.get("shapes");
  if (tool === undefined) throw new Error("no shapes tool");
  render(
    <ToolOptionsStrip tool={tool} settings={storeWith(values)} gpuPerformanceClass="VeryLow" />,
  );
}

describe("ToolOptionsStrip for the Shapes tool (TL-SHAPE-01)", () => {
  it("shows the stored shape type in the picker", () => {
    renderShapes({
      "tools.shapes.shape": { name: "rectangle" },
      "tools.shapes.drawType": "Outline",
    });
    expect(screen.getAllByText(enUS["shape.rectangle"]).length).toBeGreaterThan(0);
  });

  it("shows the current shape's outline as the picker's icon", () => {
    renderShapes({
      "tools.shapes.shape": { name: "heart" },
      "tools.shapes.drawType": "Outline",
    });
    const heart = SHAPE_REGISTRY.get("heart");
    if (heart === undefined) throw new Error("no heart shape");
    const button = screen.getByRole("button", { name: new RegExp(enUS["shape.heart"]) });
    expect(button.querySelector("svg.prop-icon path")?.getAttribute("d")).toBe(shapeIcon(heart));
  });

  it("shows the corner size only for a shape that has one", () => {
    renderShapes({
      "tools.shapes.shape": { name: "rectangle" },
      "tools.shapes.drawType": "Outline",
    });
    expect(screen.queryByText(radiusLabel)).toBeNull();
    cleanup();
    renderShapes({
      "tools.shapes.shape": { name: "roundedRectangle" },
      "tools.shapes.drawType": "Outline",
    });
    expect(screen.getByText(radiusLabel)).toBeTruthy();
  });

  it("hides the outline options in the Filled draw mode, which has no outline", () => {
    renderShapes({
      "tools.shapes.shape": { name: "rectangle" },
      "tools.shapes.drawType": "Outline",
    });
    expect(screen.getByRole("button", { name: new RegExp(dashLabel) })).toBeTruthy();
    cleanup();
    renderShapes({
      "tools.shapes.shape": { name: "rectangle" },
      "tools.shapes.drawType": "Interior",
    });
    expect(screen.queryByRole("button", { name: new RegExp(dashLabel) })).toBeNull();
  });
});
