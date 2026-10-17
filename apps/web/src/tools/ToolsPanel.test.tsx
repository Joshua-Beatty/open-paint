import { enUS } from "@openpaint/i18n";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_REGISTRY } from "./roster";
import { spansRow, ToolsPanel } from "./ToolsPanel";

afterEach(cleanup);

describe("ToolsPanel", () => {
  it("shows every tool as a named choice in roster order (TL-ROSTER-01)", () => {
    render(<ToolsPanel tools={TOOL_REGISTRY.list()} activeId="paintbrush" onSelect={vi.fn()} />);
    const names = screen.getAllByRole("radio").map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual(TOOL_REGISTRY.list().map((tool) => enUS[tool.label]));
  });

  it("marks the active tool as checked", () => {
    render(<ToolsPanel tools={TOOL_REGISTRY.list()} activeId="zoom" onSelect={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "Zoom" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Paintbrush" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("selects a tool when its button is clicked", () => {
    const onSelect = vi.fn();
    render(<ToolsPanel tools={TOOL_REGISTRY.list()} activeId="paintbrush" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("radio", { name: "Pan" }));
    expect(onSelect).toHaveBeenCalledWith("pan");
  });

  it("does not select the tool that is already active", () => {
    const onSelect = vi.fn();
    render(<ToolsPanel tools={TOOL_REGISTRY.list()} activeId="paintbrush" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("radio", { name: "Paintbrush" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("spans the last tool across both columns only when the count is odd (UI-FTW-03)", () => {
    expect([0, 1, 2, 3, 4].map((index) => spansRow(index, 5))).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
    expect([0, 1, 2, 3].map((index) => spansRow(index, 4))).toEqual([false, false, false, false]);
    expect(spansRow(0, 1)).toBe(true);
  });

  it("draws the last button double-wide for an odd roster and all square for an even one", () => {
    const tools = TOOL_REGISTRY.list();
    const odd = tools.length % 2 === 1 ? tools : tools.slice(0, -1);
    const even = tools.length % 2 === 0 ? tools : tools.slice(0, -1);
    const { container, unmount } = render(
      <ToolsPanel tools={odd} activeId="paintbrush" onSelect={vi.fn()} />,
    );
    const wide = Array.from(container.querySelectorAll(".tool-button.is-wide"));
    expect(wide.map((button) => button.getAttribute("aria-label"))).toEqual([
      enUS[odd[odd.length - 1]?.label ?? "panel.tools"],
    ]);
    unmount();
    const square = render(<ToolsPanel tools={even} activeId="paintbrush" onSelect={vi.fn()} />);
    expect(square.container.querySelectorAll(".tool-button.is-wide")).toHaveLength(0);
  });

  it("gives the wide Shapes button its square, circle and triangle side by side", () => {
    const tools = TOOL_REGISTRY.list();
    expect(tools.length % 2).toBe(1);
    expect(tools[tools.length - 1]?.id).toBe("shapes");
    render(<ToolsPanel tools={tools} activeId="paintbrush" onSelect={vi.fn()} />);
    const icon = screen.getByRole("radio", { name: "Shapes" }).querySelector("svg");
    expect(icon?.getAttribute("viewBox")).toBe("0 0 768 256");
    expect(icon?.querySelectorAll("path")).toHaveLength(3);
  });
});
