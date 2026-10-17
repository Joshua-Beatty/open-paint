import type { BuiltInCommandId } from "../commands/catalog";
import type { ShortcutController } from "../commands/shortcuts";
import type { ImageTabs } from "./image-tabs";

const GO_TO_TAB_IDS = [
  "view.goToTab1",
  "view.goToTab2",
  "view.goToTab3",
  "view.goToTab4",
  "view.goToTab5",
  "view.goToTab6",
  "view.goToTab7",
  "view.goToTab8",
  "view.goToTab9",
  "view.goToTab10",
] as const satisfies readonly BuiltInCommandId[];

/**
 * Connects the tab-switching, moving and close commands to the open images (UI-KEY-01,
 * UI-MENU-FILE Close). Alt+0 jumps to the tenth tab, Ctrl+0 stays Actual Size. The image tab
 * context menu (Alt+-) is owned by the tab strip, since it draws the menu. `close` receives the ids
 * to close, in tab order; it owns the unsaved-changes prompt. Returns the function that detaches
 * every command.
 */
export function registerTabCommands<T>(
  controller: ShortcutController<BuiltInCommandId>,
  tabs: ImageTabs<T>,
  close: (ids: readonly string[]) => void,
): () => void {
  const hasTabs = () => tabs.count > 0;
  const releases = [
    controller.register("view.nextTab", { run: () => tabs.next(), enabled: hasTabs }),
    controller.register("view.previousTab", { run: () => tabs.previous(), enabled: hasTabs }),
    controller.register("view.moveTabRight", {
      run: () => tabs.moveActive(1),
      enabled: () => tabs.count > 1,
    }),
    controller.register("view.moveTabLeft", {
      run: () => tabs.moveActive(-1),
      enabled: () => tabs.count > 1,
    }),
    controller.register("file.close", {
      run: () => {
        const active = tabs.active;
        if (active !== undefined) close([active.id]);
      },
      enabled: () => tabs.active !== undefined,
    }),
    controller.register("file.closeAll", {
      run: () => close(tabs.state.items.map((item) => item.id)),
      enabled: hasTabs,
    }),
    ...GO_TO_TAB_IDS.map((id, index) =>
      controller.register(id, {
        run: () => tabs.goTo(index + 1),
        enabled: () => tabs.count > index,
      }),
    ),
  ];
  return () => {
    for (const release of releases) release();
  };
}
