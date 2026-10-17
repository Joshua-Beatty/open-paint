import { EffectRegistry } from "@openpaint/extension-api";
import { t } from "@openpaint/i18n";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_REGISTRY, type BuiltInCommandId } from "../commands/catalog";
import { platformFromName } from "../commands/keys";
import { ShortcutController } from "../commands/shortcuts";
import { type MenuContext, type MenuState, NO_IMAGE_MENU_STATE } from "../menus/menu-model";
import { MenuBar } from "./MenuBar";

function renderMenuBar(handled: readonly BuiltInCommandId[], state: Partial<MenuState> = {}) {
  const commands = new ShortcutController(BUILT_IN_REGISTRY, platformFromName("Win32"));
  const ran: BuiltInCommandId[] = [];
  for (const id of handled) {
    commands.register(id, {
      run: () => {
        ran.push(id);
      },
    });
  }
  const context: MenuContext = {
    state: { ...NO_IMAGE_MENU_STATE, ...state },
    effects: new EffectRegistry(),
    commands,
    t,
    toolAcceptsPaste: () => false,
  };
  render(<MenuBar context={context} actions={{ onCommand: (id) => commands.invoke(id) }} />);
  return { ran };
}

function pressAlt(code: string) {
  fireEvent.keyDown(document.body, { code, altKey: true });
}

describe("MenuBar", () => {
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

  it("shows the seven main menus in the spec's order", () => {
    renderMenuBar([]);
    const names = screen.getAllByRole("button").map((button) => button.textContent);
    expect(names).toEqual(["File", "Edit", "View", "Image", "Layers", "Adjustments", "Effects"]);
  });

  it("opens a menu with Alt and its underlined letter, showing enable states", async () => {
    renderMenuBar(["file.new"]);
    pressAlt("KeyF");
    const menu = await screen.findByRole("menu", { name: "File" });
    expect(
      within(menu)
        .getByRole("menuitem", { name: /^New\.\.\./ })
        .getAttribute("aria-disabled"),
    ).toBeNull();
    expect(
      within(menu).getByRole("menuitem", { name: "SaveCtrl+S" }).getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("runs a command when its item is chosen", async () => {
    const { ran } = renderMenuBar(["file.new"]);
    pressAlt("KeyF");
    fireEvent.click(await screen.findByRole("menuitem", { name: /^New\.\.\./ }));
    expect(ran).toEqual(["file.new"]);
  });

  it("chooses an item from its access key while the menu is open", async () => {
    const { ran } = renderMenuBar(["file.open"]);
    pressAlt("KeyF");
    const menu = await screen.findByRole("menu", { name: "File" });
    fireEvent.keyDown(menu, { key: "o" });
    expect(ran).toEqual(["file.open"]);
  });

  it("does not choose a disabled item from its access key", async () => {
    const { ran } = renderMenuBar(["file.save"]);
    pressAlt("KeyF");
    const menu = await screen.findByRole("menu", { name: "File" });
    fireEvent.keyDown(menu, { key: "s" });
    expect(ran).toEqual([]);
  });

  it("marks checked items as selected", async () => {
    renderMenuBar([], {
      hasDocument: true,
      view: {
        fitToWindow: false,
        pixelGrid: false,
        rulers: true,
        units: "pixels",
        fullScreen: false,
      },
    });
    pressAlt("KeyV");
    const menu = await screen.findByRole("menu", { name: "View" });
    expect(
      within(menu)
        .getByRole("menuitemcheckbox", { name: /^Rulers/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(menu)
        .getByRole("menuitemcheckbox", { name: /^Pixel grid/ })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("opens a submenu from its group item", async () => {
    renderMenuBar([], { hasDocument: true, clipboardHasSelection: true });
    pressAlt("KeyE");
    const menu = await screen.findByRole("menu", { name: "Edit" });
    fireEvent.keyDown(within(menu).getByRole("menuitem", { name: /^Paste Selection/ }), {
      key: "ArrowRight",
    });
    expect(await screen.findByRole("menuitem", { name: /^Replace/ })).toBeDefined();
  });

  it("leaves a menu closed without the Alt modifier", () => {
    renderMenuBar([]);
    fireEvent.keyDown(document.body, { code: "KeyF" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
