import { describe, expect, it, vi } from "vitest";
import { BUILT_IN_REGISTRY } from "../commands/catalog";
import { platformFromName } from "../commands/keys";
import { ShortcutController } from "../commands/shortcuts";
import {
  type FullScreenHost,
  registerFullScreen,
  registerUnitCommands,
  registerViewCommands,
  registerViewToggles,
  type ToggleSettings,
  type ViewPort,
} from "./status-commands";

function fakeFullScreenHost(enabled: boolean) {
  const host = {
    documentElement: { requestFullscreen: vi.fn(async () => undefined) },
    fullscreenElement: null as Element | null,
    fullscreenEnabled: enabled,
    exitFullscreen: vi.fn(async () => undefined),
  };
  return host;
}

describe("registerFullScreen", () => {
  it("enters fullscreen on the page root, then leaves it (WEB-UI-05)", () => {
    const commands = controller();
    const host = fakeFullScreenHost(true);
    registerFullScreen(commands, host as unknown as FullScreenHost);

    expect(commands.invoke("view.fullScreen")).toBe(true);
    expect(host.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);

    host.fullscreenElement = host.documentElement as unknown as Element;
    expect(commands.invoke("view.fullScreen")).toBe(true);
    expect(host.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("stays disabled where the Fullscreen API is not enabled", () => {
    const commands = controller();
    const host = fakeFullScreenHost(false);
    registerFullScreen(commands, host as unknown as FullScreenHost);

    expect(commands.isEnabled("view.fullScreen")).toBe(false);
    expect(commands.invoke("view.fullScreen")).toBe(false);
    expect(host.documentElement.requestFullscreen).not.toHaveBeenCalled();
  });
});

function controller() {
  return new ShortcutController(BUILT_IN_REGISTRY, platformFromName("Win32"));
}

function fakeEngine() {
  const view = vi.fn<ViewPort["view"]>(async () => ({ mode: "fixed" as const, zoom: 1 }));
  return { view } satisfies ViewPort;
}

describe("registerViewCommands", () => {
  it("runs the zoom commands on the engine's view while an image is open", () => {
    const commands = controller();
    const engine = fakeEngine();
    const release = registerViewCommands(commands, engine, true);

    expect(commands.invoke("view.zoomIn")).toBe(true);
    expect(engine.view).toHaveBeenLastCalledWith({ type: "zoomIn" });
    expect(commands.invoke("view.zoomOut")).toBe(true);
    expect(engine.view).toHaveBeenLastCalledWith({ type: "zoomOut" });
    expect(commands.invoke("view.actualSize")).toBe(true);
    expect(engine.view).toHaveBeenLastCalledWith({ type: "actualSize" });
    expect(commands.invoke("view.zoomToWindow")).toBe(true);
    expect(engine.view).toHaveBeenLastCalledWith({ type: "fit" });

    release();
    expect(commands.isEnabled("view.zoomIn")).toBe(false);
  });

  it("toggles Zoom to Window back to Actual Size while the image already fits (UI-VIEW-01)", () => {
    const commands = controller();
    const engine = fakeEngine();
    let fitting = false;
    registerViewCommands(commands, engine, true, undefined, () => fitting);

    commands.invoke("view.zoomToWindow");
    expect(engine.view).toHaveBeenLastCalledWith({ type: "fit" });
    fitting = true;
    commands.invoke("view.zoomToWindow");
    expect(engine.view).toHaveBeenLastCalledWith({ type: "actualSize" });
  });

  it("stays disabled without an image, so keys, menus and buttons all refuse", () => {
    const commands = controller();
    const engine = fakeEngine();
    registerViewCommands(commands, engine, false);

    expect(commands.isEnabled("view.zoomIn")).toBe(false);
    expect(commands.invoke("view.zoomIn")).toBe(false);
    expect(engine.view).not.toHaveBeenCalled();
  });

  it("registers nothing before the engine has started", () => {
    const commands = controller();
    registerViewCommands(commands, undefined, true);
    expect(commands.isEnabled("view.zoomIn")).toBe(false);
  });

  it("scrolls the canvas with the page, edge and Shift+Page keys (UI-KEY-02)", () => {
    const commands = controller();
    const engine = fakeEngine();
    registerViewCommands(commands, engine, true);

    commands.invoke("view.pageUp");
    expect(engine.view).toHaveBeenLastCalledWith({ type: "page", direction: "up" });
    commands.invoke("view.pageDown");
    expect(engine.view).toHaveBeenLastCalledWith({ type: "page", direction: "down" });
    commands.invoke("view.pageLeft");
    expect(engine.view).toHaveBeenLastCalledWith({ type: "page", direction: "left" });
    commands.invoke("view.pageRight");
    expect(engine.view).toHaveBeenLastCalledWith({ type: "page", direction: "right" });
    commands.invoke("view.toStart");
    expect(engine.view).toHaveBeenLastCalledWith({ type: "edge", edge: "start" });
    commands.invoke("view.toEnd");
    expect(engine.view).toHaveBeenLastCalledWith({ type: "edge", edge: "end" });
  });

  it("binds Page Up and Home to the scroll commands from the keyboard", () => {
    const commands = controller();
    const engine = fakeEngine();
    registerViewCommands(commands, engine, true);
    const press = (code: string, modifiers: KeyboardEventInit = {}) =>
      commands.handleKeyDown(new KeyboardEvent("keydown", { code, ...modifiers }), {
        editing: false,
      });

    expect(press("PageUp")).toBe(true);
    expect(engine.view).toHaveBeenLastCalledWith({ type: "page", direction: "up" });
    expect(press("PageDown", { shiftKey: true })).toBe(true);
    expect(engine.view).toHaveBeenLastCalledWith({ type: "page", direction: "right" });
    expect(press("Home", { ctrlKey: true })).toBe(true);
    expect(engine.view).toHaveBeenLastCalledWith({ type: "edge", edge: "start" });
  });

  it("runs the scroll keys only while the canvas has focus", () => {
    const commands = controller();
    const engine = fakeEngine();
    let canvasFocused = false;
    registerViewCommands(commands, engine, true, () => canvasFocused);

    expect(commands.isEnabled("view.pageUp")).toBe(false);
    canvasFocused = true;
    expect(commands.isEnabled("view.pageUp")).toBe(true);
    expect(commands.invoke("view.toEnd")).toBe(true);
    expect(engine.view).toHaveBeenLastCalledWith({ type: "edge", edge: "end" });
  });
});

describe("registerViewToggles", () => {
  it("flips the pixel grid and ruler settings (UI-VIEW-03, UI-VIEW-04)", () => {
    const commands = controller();
    const stored = new Map<string, unknown>([
      ["workspace.showPixelGrid", false],
      ["workspace.showRulers", true],
    ]);
    const settings = {
      get: vi.fn((key: string) => stored.get(key)),
      set: vi.fn((key: string, value: unknown) => {
        stored.set(key, value);
      }),
    };
    registerViewToggles(commands, settings as unknown as ToggleSettings, true);

    expect(commands.invoke("view.pixelGrid")).toBe(true);
    expect(stored.get("workspace.showPixelGrid")).toBe(true);
    expect(commands.invoke("view.rulers")).toBe(true);
    expect(stored.get("workspace.showRulers")).toBe(false);
  });

  it("stays disabled without an image and before the settings open", () => {
    const commands = controller();
    registerViewToggles(commands, null, true);
    expect(commands.isEnabled("view.pixelGrid")).toBe(false);

    const settings = { get: vi.fn(() => undefined), set: vi.fn() };
    const release = registerViewToggles(commands, settings as unknown as ToggleSettings, false);
    expect(commands.isEnabled("view.rulers")).toBe(false);
    release();
  });
});

describe("registerUnitCommands", () => {
  it("writes the chosen unit to the stored measurement unit (UI-VIEW-05)", () => {
    const commands = controller();
    const settings = { set: vi.fn() };
    registerUnitCommands(commands, settings);

    expect(commands.invoke("view.unitsInches")).toBe(true);
    expect(settings.set).toHaveBeenLastCalledWith("workspace.measurementUnit", "Inch");
    commands.invoke("view.unitsCentimeters");
    expect(settings.set).toHaveBeenLastCalledWith("workspace.measurementUnit", "Centimeter");
    commands.invoke("view.unitsPixels");
    expect(settings.set).toHaveBeenLastCalledWith("workspace.measurementUnit", "Pixel");
  });

  it("registers nothing until the settings have opened", () => {
    const commands = controller();
    registerUnitCommands(commands, null);
    expect(commands.isEnabled("view.unitsPixels")).toBe(false);
  });
});
