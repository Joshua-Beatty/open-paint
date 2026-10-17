import { ROTATE_ZOOM_ID } from "@openpaint/effects";
import type { EffectRegistry } from "@openpaint/extension-api";
import type { BuiltInCommandId } from "../commands/catalog";
import type { ShortcutController } from "../commands/shortcuts";
import { ADJUSTMENT_COMMANDS } from "../menus/menu-model";
import type { EffectRuntime } from "./effect-runtime";

/**
 * Binds Repeat Last Effect (Ctrl+F, FX-FW-REPEAT-01) to the runtime. The menu item and the key run
 * the same command, so their enable rules match. Returns the function that detaches it.
 */
export function registerEffectCommands(
  controller: ShortcutController<BuiltInCommandId>,
  runtime: EffectRuntime,
): () => void {
  return controller.register("effects.repeat", {
    run: () => runtime.repeat(),
    enabled: () => runtime.canRepeat,
  });
}

/**
 * Binds the Layers menu's Rotate / Zoom item and its Ctrl+Shift+Z key (DOC-LYR-05i) to the runtime,
 * since the effect is hidden from the Effects menu. Returns the function that detaches it.
 */
export function registerRotateZoomCommand(
  controller: ShortcutController<BuiltInCommandId>,
  runtime: EffectRuntime,
): () => void {
  return controller.register("layers.rotateZoom", {
    run: () => runtime.start(ROTATE_ZOOM_ID),
    enabled: () => runtime.canStart,
  });
}

/**
 * Binds the shortcut of every registered adjustment (ADJ-MENU-04, ADJ-MENU-05) to the runtime, so
 * the keys work before the Adjustments menu has been opened. Adjustments without a registered
 * effect get no handler. Returns the function that detaches them all.
 */
export function registerAdjustmentCommands(
  controller: ShortcutController<BuiltInCommandId>,
  runtime: EffectRuntime,
  effects: EffectRegistry,
): () => void {
  const releases = Object.entries(ADJUSTMENT_COMMANDS).flatMap(([effectId, command]) => {
    if (command === undefined || effects.get(effectId)?.category !== "adjustment") return [];
    return [
      controller.register(command, {
        run: () => runtime.start(effectId),
        enabled: () => runtime.canStart,
      }),
    ];
  });
  return () => {
    for (const release of releases) release();
  };
}
