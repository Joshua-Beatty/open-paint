import type { BuiltInCommandId } from "../commands/catalog";
import type { ShortcutController } from "../commands/shortcuts";
import type { ImageDialogKind } from "./ImageDialogs";

/**
 * Connects File > New, Image > Resize and Image > Canvas Size to the image dialogs. Keys, menus
 * and enable rules share the controller (UI-MENU-IMAGE). New is always enabled, and the other two
 * need an open image. Returns the function that detaches the commands.
 */
export function registerImageDialogCommands(
  controller: ShortcutController<BuiltInCommandId>,
  options: { readonly hasDocument: () => boolean; readonly open: (kind: ImageDialogKind) => void },
): () => void {
  const releases = [
    controller.register("file.new", { run: () => options.open("new") }),
    controller.register("image.resize", {
      run: () => options.open("resize"),
      enabled: options.hasDocument,
    }),
    controller.register("image.canvasSize", {
      run: () => options.open("canvasSize"),
      enabled: options.hasDocument,
    }),
  ];
  return () => {
    for (const release of releases) release();
  };
}
