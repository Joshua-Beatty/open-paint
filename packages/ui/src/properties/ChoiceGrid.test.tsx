// @vitest-environment jsdom
import {
  type ChoiceOption,
  definePropertySchema,
  type PropertyValues,
} from "@openpaint/properties";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextGridCell } from "./ChoiceGrid";
import { PropertyDialog } from "./PropertyDialog";

const options = [
  { value: "a", label: "blend.normal", icon: "M2 2h12" },
  { value: "b", label: "blend.multiply", icon: "M2 2h12" },
  { value: "c", label: "blend.lighten", icon: "M2 2h12" },
  { value: "d", label: "blend.darken", icon: "M2 2h12" },
  { value: "e", label: "blend.screen", icon: "M2 2h12" },
] as const;

const grid = {
  rows: [
    ["a", "b", null],
    ["c", "d", "e"],
  ],
  gapAfterRows: [0],
} as const;

const schema = definePropertySchema({
  properties: [
    {
      kind: "choice",
      key: "corner",
      label: "property.position",
      defaultValue: "a",
      options,
      control: { controlType: "radioButtons", choiceGrid: grid },
    },
  ],
});

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderGrid() {
  const onOk = vi.fn<(values: PropertyValues) => void>();
  render(<PropertyDialog isOpen schema={schema} title="Grid" onOk={onOk} onCancel={() => {}} />);
  return onOk;
}

describe("choice grid (ControlOptions.choiceGrid)", () => {
  it("shows one radio group of icon buttons named by the option labels, in grid cells", () => {
    renderGrid();
    const group = screen.getByRole("radiogroup", { name: "Position" });
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("value"))).toEqual(["a", "b", "c", "d", "e"]);
    expect(screen.getByRole("radio", { name: "Multiply" })).toBeDefined();
    expect(group.querySelectorAll("svg").length).toBe(5);
    const cell = screen.getByRole("radio", { name: "Screen" }).closest("label");
    // Column 3 and row 2 after the row gap track (track 3).
    expect(cell?.style.gridColumn).toBe("3");
    expect(cell?.style.gridRow).toBe("3");
    expect(group.style.gridTemplateRows.match(/var\(/g)?.length).toBe(3);
  });

  it("chooses a cell by clicking it", () => {
    const onOk = renderGrid();
    fireEvent.click(screen.getByRole("radio", { name: "Darken" }));
    expect((screen.getByRole("radio", { name: "Darken" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onOk.mock.calls.at(-1)?.[0]).toEqual({ corner: "d" });
  });

  it("moves by row and column with the arrow keys", () => {
    renderGrid();
    const first = screen.getByRole("radio", { name: "Normal" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const below = screen.getByRole("radio", { name: "Lighten" }) as HTMLInputElement;
    expect(below.checked).toBe(true);
    expect(document.activeElement).toBe(below);
    fireEvent.keyDown(below, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
    expect((screen.getByRole("radio", { name: "Screen" }) as HTMLInputElement).checked).toBe(true);
    // Up from Screen is an empty cell at the edge: the choice stays.
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
    expect((screen.getByRole("radio", { name: "Screen" }) as HTMLInputElement).checked).toBe(true);
  });

  it("skips empty and disabled cells and stops at the edge", () => {
    const cells: ChoiceOption[] = [
      { value: "x", label: "blend.normal", disabled: true },
      ...options,
    ];
    const wide = { rows: [["a", null, "x", "b"]] };
    expect(nextGridCell(wide, cells, 0, 0, [0, 1])).toEqual({ row: 0, column: 3 });
    expect(nextGridCell(wide, cells, 0, 3, [0, 1])).toBeUndefined();
    expect(nextGridCell(grid, cells, 1, 2, [-1, 0])).toBeUndefined();
    expect(nextGridCell(grid, cells, 0, 1, [1, 0])).toEqual({ row: 1, column: 1 });
  });
});
