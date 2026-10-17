import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuxPanelToggles } from "./AuxPanelToggles";
import { DEFAULT_PANEL_LAYOUT, type PanelLayout } from "./panel-layout";

const commands = {
  isEnabled: () => true,
  labels: () => ({ shortcuts: ["F5"] }),
};

describe("AuxPanelToggles (UI-AUX-01, UI-AUX-02)", () => {
  afterEach(() => {
    cleanup();
  });

  it("lists the four panels in the aux order, each in a group", () => {
    render(
      <AuxPanelToggles layout={DEFAULT_PANEL_LAYOUT} commands={commands} onToggle={() => {}} />,
    );
    expect(screen.getByRole("group", { name: "Panels" })).toBeDefined();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Tools",
      "History",
      "Layers",
      "Colors",
    ]);
  });

  it("checks each toggle while its panel is visible", () => {
    const layout: PanelLayout = {
      ...DEFAULT_PANEL_LAYOUT,
      visible: { ...DEFAULT_PANEL_LAYOUT.visible, layers: false },
    };
    render(<AuxPanelToggles layout={layout} commands={commands} onToggle={() => {}} />);
    expect(screen.getByRole("button", { name: "Tools" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Layers" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("shows the panel name and its shortcut in the tooltip", async () => {
    render(
      <AuxPanelToggles layout={DEFAULT_PANEL_LAYOUT} commands={commands} onToggle={() => {}} />,
    );
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => screen.getByRole("button", { name: "Tools" }).focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe("Tools (F5)");
  });

  it("reports the panel that was toggled", () => {
    const onToggle = vi.fn();
    render(
      <AuxPanelToggles layout={DEFAULT_PANEL_LAYOUT} commands={commands} onToggle={onToggle} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Colors" }));
    expect(onToggle).toHaveBeenCalledWith("colors");
  });
});
