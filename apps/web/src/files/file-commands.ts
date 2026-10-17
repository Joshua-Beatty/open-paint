import type { BuiltInCommandId } from "../commands/catalog";
import type { ShortcutController } from "../commands/shortcuts";
import type { FileFlows } from "./file-flows";

export interface FileCommandOptions {
  readonly flows: FileFlows;
  /** An image is open, so Save and Save As can run. */
  readonly hasImage: () => boolean;
  /** At least one open image has unsaved changes (FMT-SAVE-01 Save All). */
  readonly hasUnsaved: () => boolean;
  readonly hasRecent: () => boolean;
}

/**
 * Connects File > Open, Save, Save As, Save All, Print, Clear this list and Layers > Import From File
 * to the file flows. Keys, menus
 * and enable rules share the controller. Returns the function that detaches the commands.
 */
export function registerFileCommands(
  controller: ShortcutController<BuiltInCommandId>,
  options: FileCommandOptions,
): () => void {
  const { flows } = options;
  const releases = [
    controller.register("file.open", { run: () => flows.run(() => flows.openFiles()) }),
    controller.register("file.save", {
      run: () => flows.run(() => flows.saveActive(false)),
      enabled: options.hasImage,
    }),
    controller.register("file.saveAs", {
      run: () => flows.run(() => flows.saveActive(true)),
      enabled: options.hasImage,
    }),
    controller.register("file.saveAll", {
      run: () => flows.run(() => flows.saveAll()),
      enabled: options.hasUnsaved,
    }),
    controller.register("file.print", {
      run: () => flows.run(() => flows.printActive()),
      enabled: options.hasImage,
    }),
    controller.register("file.clearRecent", {
      run: () => flows.clearRecent(),
      enabled: options.hasRecent,
    }),
    controller.register("layers.importFromFile", {
      run: () => flows.run(() => flows.importFromFile()),
      enabled: options.hasImage,
    }),
  ];
  return () => {
    for (const release of releases) release();
  };
}
