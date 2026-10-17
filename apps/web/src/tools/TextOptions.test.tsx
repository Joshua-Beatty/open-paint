import { enUS } from "@openpaint/i18n";
import type { SettingsStore } from "@openpaint/storage";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_REGISTRY } from "./roster";
import { ToolOptionsStrip } from "./ToolOptionsStrip";

afterEach(cleanup);

function storeWith(values: Record<string, unknown>) {
  const set = vi.fn((path: string, value: unknown) => {
    values[path] = value;
  });
  const store = {
    get: (path: string) => values[path],
    set,
    onChange: () => () => undefined,
  };
  return { store: store as unknown as SettingsStore, set };
}

function renderFor(toolId: string, values: Record<string, unknown>) {
  const tool = TOOL_REGISTRY.get(toolId);
  if (tool === undefined) throw new Error(`no ${toolId} tool`);
  const { store, set } = storeWith(values);
  render(<ToolOptionsStrip tool={tool} settings={store} gpuPerformanceClass="VeryLow" />);
  return { set };
}

describe("Text tool options (TL-OPT-TEXT, WEB-FONT-01)", () => {
  it("turns a style on through its toggle, keeping the others", () => {
    const { set } = renderFor("text", { "tools.text.fontStyle": "Italic" });
    fireEvent.click(screen.getByRole("button", { name: enUS["tool.text.styleBold"] }));
    expect(set).toHaveBeenLastCalledWith("tools.text.fontStyle", "Bold,Italic");
  });

  it("shows the stored styles as pressed", () => {
    renderFor("text", { "tools.text.fontStyle": "Underline" });
    expect(
      screen.getByRole("button", { name: enUS["tool.text.styleUnderline"], pressed: true }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: enUS["tool.text.styleBold"], pressed: false }),
    ).toBeTruthy();
  });

  it("shows the font list with the sample line, and not the generic font field", () => {
    renderFor("text", { "tools.text.fontFamily": "Noto Sans" });
    expect(screen.getByText(enUS["tool.text.fontSample"])).toBeTruthy();
    expect(screen.queryByText(enUS["settings.field.tool.fontFamily"])).toBeNull();
    expect(screen.getByRole("button", { name: enUS["tool.text.addFont"] })).toBeTruthy();
  });

  it("the other tools keep their own option fields and no text controls", () => {
    renderFor("paintbrush", {});
    expect(screen.queryByRole("group", { name: enUS["tool.text.styles"] })).toBeNull();
  });
});
