import { EffectRegistry } from "@openpaint/extension-api";
import { t } from "@openpaint/i18n";
import { iconShape } from "@openpaint/properties";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_REGISTRY, type BuiltInCommandId } from "../commands/catalog";
import { platformFromName } from "../commands/keys";
import { ShortcutController } from "../commands/shortcuts";
import { commonActions, type MenuState, NO_IMAGE_MENU_STATE } from "../menus/menu-model";
import { CommonActionsBar, commonActionIcon } from "./CommonActionsBar";

/** Counts the renders of the bar and its buttons: each one reads the translation once. */
const translations = vi.hoisted(() => ({ count: 0 }));
vi.mock("@openpaint/i18n/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openpaint/i18n/react")>();
  return {
    ...actual,
    useTranslation: () => {
      translations.count++;
      return actual.useTranslation();
    },
  };
});

const commands = new ShortcutController(BUILT_IN_REGISTRY, platformFromName("Win32"));
for (const definition of BUILT_IN_REGISTRY.list()) {
  commands.register(definition.id, { run: () => undefined });
}

function entries(state: Partial<MenuState> = {}) {
  return commonActions({
    state: { ...NO_IMAGE_MENU_STATE, ...state },
    effects: new EffectRegistry(),
    commands,
    t,
    toolAcceptsPaste: () => false,
  });
}

describe("CommonActionsBar (UI-TB-01)", () => {
  afterEach(() => {
    cleanup();
  });

  it("is a toolbar of icon buttons named after their actions, disabled without an image", () => {
    render(<CommonActionsBar entries={entries()} onCommand={() => {}} />);
    const bar = screen.getByRole("toolbar", { name: "Common actions" });
    expect(bar.querySelectorAll("svg")).toHaveLength(14);
    expect(screen.getByRole("button", { name: "New" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Deselect" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Undo" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByRole("separator")).toHaveLength(4);
  });

  it("gives every toolbar command an icon from the icon set", () => {
    const actions = entries().filter((entry) => entry.kind === "action");
    expect(actions).toHaveLength(14);
    for (const action of actions) {
      const icon = commonActionIcon(action.id);
      expect(icon, action.id).toBeDefined();
      expect(iconShape(icon ?? "").filled, action.id).toBe(true);
    }
  });

  it("draws every button as a filled icon in the text color on the set's grid", () => {
    render(<CommonActionsBar entries={entries()} onCommand={() => {}} />);
    for (const button of screen.getAllByRole("button")) {
      const icon = button.querySelector("svg.app-common-icon");
      const name = button.getAttribute("aria-label") ?? "";
      expect(icon?.getAttribute("viewBox"), name).toBe("0 0 256 256");
      expect(icon?.classList.contains("icon-filled"), name).toBe(true);
      expect(icon?.getAttribute("aria-hidden"), name).toBe("true");
      const paths = [...(icon?.querySelectorAll("path") ?? [])];
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.every((path) => (path.getAttribute("d") ?? "").length > 0)).toBe(true);
    }
  });

  it("runs the button's command, and shows the toggle state of the pixel grid", () => {
    const onCommand = vi.fn<(id: BuiltInCommandId) => void>();
    const view = { ...NO_IMAGE_MENU_STATE.view, pixelGrid: true };
    render(
      <CommonActionsBar
        entries={entries({ hasDocument: true, hasSelection: true, view })}
        onCommand={onCommand}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Deselect" }));
    expect(onCommand).toHaveBeenCalledWith("edit.deselect");
    const grid = screen.getByRole("button", { name: "Display pixel grid when zoomed in" });
    expect(grid.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(grid);
    expect(onCommand).toHaveBeenLastCalledWith("view.pixelGrid");
  });

  it("shows the action name and its shortcut in the tooltip", async () => {
    render(<CommonActionsBar entries={entries({ hasDocument: true })} onCommand={() => {}} />);
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => screen.getByRole("button", { name: "Save" }).focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe("Save (Ctrl+S)");
  });

  it("moves focus between the buttons with the arrow keys (WEB-A11Y-01)", () => {
    render(<CommonActionsBar entries={entries()} onCommand={() => {}} />);
    const first = screen.getByRole("button", { name: "New" });
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open" }));
  });

  it("renders again only when a button's state changes (L3)", () => {
    const onCommand = () => {};
    const view = (state: Partial<MenuState>) => (
      <CommonActionsBar entries={entries(state)} onCommand={onCommand} />
    );
    const { rerender } = render(view({ hasDocument: true }));
    const first = translations.count;
    rerender(view({ hasDocument: true }));
    expect(translations.count).toBe(first);
    rerender(view({ hasDocument: true, hasSelection: true }));
    expect(translations.count).toBeGreaterThan(first);
  });
});
