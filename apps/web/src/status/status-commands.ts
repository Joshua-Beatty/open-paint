import type { EngineHandle } from "@openpaint/engine";
import type { SettingsStore } from "@openpaint/storage";
import type { BuiltInCommandId } from "../commands/catalog";
import type { ShortcutController } from "../commands/shortcuts";
import { MEASURE_UNITS, type MeasureUnit } from "./status-model";

/** The part of the engine the view commands drive. */
export type ViewPort = Pick<EngineHandle, "view">;

/** The settings the units commands write (UI-VIEW-05). */
export type UnitSettings = Pick<SettingsStore, "set">;

/** The settings the view toggles read and write. */
export type ToggleSettings = Pick<SettingsStore, "get" | "set">;

/** The command that selects each display unit (the View menu's Units items). */
export const UNIT_COMMAND: Record<MeasureUnit, BuiltInCommandId> = {
  Pixel: "view.unitsPixels",
  Inch: "view.unitsInches",
  Centimeter: "view.unitsCentimeters",
};

/**
 * Connects the zoom commands (UI-VIEW-01, UI-SB-01) to the engine's view. The View menu, the keys
 * and the status bar buttons all run them through the controller, so they share enable rules. They
 * can run only while an image is open. Returns the function that detaches them.
 *
 * Zoom to Window toggles (UI-VIEW-01): while `isFitting` holds it switches to Actual Size.
 */
export function registerViewCommands(
  controller: ShortcutController<BuiltInCommandId>,
  engine: ViewPort | undefined,
  hasImage: boolean,
  canvasHasFocus: () => boolean = () => true,
  isFitting: () => boolean = () => false,
): () => void {
  if (engine === undefined) return () => {};
  const enabled = () => hasImage;
  const navigation = () => hasImage && canvasHasFocus();
  const detach = [
    controller.register("view.pageUp", {
      run: () => void engine.view({ type: "page", direction: "up" }),
      enabled: navigation,
    }),
    controller.register("view.pageDown", {
      run: () => void engine.view({ type: "page", direction: "down" }),
      enabled: navigation,
    }),
    controller.register("view.pageLeft", {
      run: () => void engine.view({ type: "page", direction: "left" }),
      enabled: navigation,
    }),
    controller.register("view.pageRight", {
      run: () => void engine.view({ type: "page", direction: "right" }),
      enabled: navigation,
    }),
    controller.register("view.toStart", {
      run: () => void engine.view({ type: "edge", edge: "start" }),
      enabled: navigation,
    }),
    controller.register("view.toEnd", {
      run: () => void engine.view({ type: "edge", edge: "end" }),
      enabled: navigation,
    }),
    controller.register("view.zoomIn", {
      run: () => void engine.view({ type: "zoomIn" }),
      enabled,
    }),
    controller.register("view.zoomOut", {
      run: () => void engine.view({ type: "zoomOut" }),
      enabled,
    }),
    controller.register("view.actualSize", {
      run: () => void engine.view({ type: "actualSize" }),
      enabled,
    }),
    controller.register("view.zoomToWindow", {
      run: () => void engine.view(isFitting() ? { type: "actualSize" } : { type: "fit" }),
      enabled,
    }),
  ];
  return () => {
    for (const release of detach) release();
  };
}

/**
 * Connects the pixel grid and ruler toggles (UI-VIEW-03, UI-VIEW-04) to their persisted settings.
 * The View menu's checkmarks and the canvas overlay both read the same settings.
 */
export function registerViewToggles(
  controller: ShortcutController<BuiltInCommandId>,
  settings: ToggleSettings | null,
  hasImage: boolean,
): () => void {
  if (settings === null) return () => {};
  const flip = (key: "workspace.showPixelGrid" | "workspace.showRulers") => () =>
    settings.set(key, settings.get(key) !== true);
  const detach = [
    controller.register("view.pixelGrid", {
      run: flip("workspace.showPixelGrid"),
      enabled: () => hasImage,
    }),
    controller.register("view.rulers", {
      run: flip("workspace.showRulers"),
      enabled: () => hasImage,
    }),
  ];
  return () => {
    for (const release of detach) release();
  };
}

/** The part of the page the Full Screen command drives (WEB-UI-05). */
export type FullScreenHost = Pick<
  Document,
  "documentElement" | "fullscreenElement" | "fullscreenEnabled" | "exitFullscreen"
>;

/**
 * Connects View › Full Screen (WEB-UI-05) to the Fullscreen API: it enters fullscreen on the page
 * root, or leaves it when the page is already fullscreen. It runs only where the API is enabled.
 * Returns the function that detaches it.
 */
export function registerFullScreen(
  controller: ShortcutController<BuiltInCommandId>,
  host: FullScreenHost,
): () => void {
  const detach = controller.register("view.fullScreen", {
    run: () => {
      if (host.fullscreenElement !== null) void host.exitFullscreen();
      else void host.documentElement.requestFullscreen();
    },
    enabled: () => host.fullscreenEnabled,
  });
  return detach;
}

/**
 * Connects the three unit commands to the stored display unit (UI-VIEW-05). The choice is global
 * and persisted, so the View menu, the status bar and Settings all show the same unit.
 */
export function registerUnitCommands(
  controller: ShortcutController<BuiltInCommandId>,
  settings: UnitSettings | null,
): () => void {
  if (settings === null) return () => {};
  const detach = MEASURE_UNITS.map((unit) =>
    controller.register(UNIT_COMMAND[unit], {
      run: () => settings.set("workspace.measurementUnit", unit),
    }),
  );
  return () => {
    for (const release of detach) release();
  };
}
