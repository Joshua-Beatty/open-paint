import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from "react";
import {
  Button,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  Separator,
  SubmenuTrigger,
} from "react-aria-components";
import type { BuiltInCommandId } from "../commands/catalog";
import {
  buildMenu,
  MENU_NAMES,
  type MenuAction,
  type MenuContext,
  type MenuEntry,
  type MenuGroupEntry,
  type MenuItemEntry,
  type MenuName,
  menuTitle,
  plainLabel,
  splitAccessKey,
} from "../menus/menu-model";

/** Where a menu item goes when it is chosen: a command, or an effect in the Effects menus. */
export interface MenuActions {
  readonly onCommand: (id: BuiltInCommandId) => void;
  readonly onEffect?: ((effect: string) => void) | undefined;
  /** Opens an Open Recent entry (FMT-OPEN-06). */
  readonly onRecent?: ((id: number) => void) | undefined;
}

/** A label with its access key underlined (UI-MENU, access keys). */
export function AccessLabel({ text }: { readonly text: string }) {
  const parts = splitAccessKey(text);
  if (parts.accessKey === undefined) return text;
  return (
    <>
      {parts.before}
      <u>{parts.accessKey}</u>
      {parts.after}
    </>
  );
}

function runAction(action: MenuAction | undefined, actions: MenuActions): void {
  if (action?.type === "command") actions.onCommand(action.command);
  if (action?.type === "effect") actions.onEffect?.(action.effect);
  if (action?.type === "recent") actions.onRecent?.(action.id);
}

export interface MenuListProps {
  readonly label: string;
  readonly entries: readonly MenuEntry[];
  readonly actions: MenuActions;
  /** Where focus goes when the menu opens. The tab context menu opened by keyboard focuses its first item. */
  readonly autoFocus?: boolean | "first" | "last";
}

/**
 * One menu or submenu. Letter keys act as access keys: the matching item is focused and chosen,
 * as if Enter was pressed on it, so it closes the menu like any other choice.
 */
export function MenuList({ label, entries, actions, autoFocus }: MenuListProps) {
  const root = useRef<HTMLDivElement>(null);
  const checked = entries.flatMap((entry) =>
    entry.kind === "item" && entry.checked ? [entry.id] : [],
  );
  const selectable = checked.length > 0;

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const element = root.current;
    if (element === null || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key.length !== 1 || !(event.target instanceof Node)) return;
    if (!element.contains(event.target)) return;
    const wanted = event.key.toUpperCase();
    const position = entries
      .filter((entry): entry is MenuItemEntry | MenuGroupEntry => entry.kind !== "separator")
      .findIndex(
        (entry) =>
          (entry.kind === "group" || entry.enabled) &&
          splitAccessKey(entry.label).accessKey?.toUpperCase() === wanted,
      );
    if (position < 0) return;
    const target = element.querySelectorAll<HTMLElement>('[role^="menuitem"]').item(position);
    if (target === null) return;
    event.preventDefault();
    target.focus();
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  };

  return (
    <div ref={root} onKeyDownCapture={onKeyDown}>
      <Menu
        aria-label={label}
        autoFocus={autoFocus}
        className="app-menu"
        selectionMode={selectable ? "multiple" : undefined}
        selectedKeys={selectable ? checked : undefined}
      >
        <MenuEntries entries={entries} actions={actions} />
      </Menu>
    </div>
  );
}

interface MenuEntriesProps {
  readonly entries: readonly MenuEntry[];
  readonly actions: MenuActions;
}

function MenuEntries({ entries, actions }: MenuEntriesProps) {
  return (
    <>
      {entries.map((entry, index) => {
        if (entry.kind === "separator") {
          // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity and the list is static
          return <Separator key={`separator-${index}`} className="app-menu-separator" />;
        }
        if (entry.kind === "group") {
          return (
            <SubmenuTrigger key={entry.id}>
              <MenuItem
                id={entry.id}
                textValue={plainLabel(entry.label)}
                className="app-menu-item app-menu-group"
              >
                <span className="app-menu-label">
                  <AccessLabel text={entry.label} />
                </span>
              </MenuItem>
              <Popover className="app-popover" placement="end top">
                <MenuList
                  label={plainLabel(entry.label)}
                  entries={entry.entries}
                  actions={actions}
                />
              </Popover>
            </SubmenuTrigger>
          );
        }
        return (
          <MenuItem
            key={entry.id}
            id={entry.id}
            textValue={plainLabel(entry.label)}
            isDisabled={!entry.enabled}
            className="app-menu-item"
            onAction={() => runAction(entry.action, actions)}
          >
            {entry.thumbnail !== undefined && (
              <img className="app-menu-thumbnail" src={entry.thumbnail} alt="" />
            )}
            <span className="app-menu-label">
              <AccessLabel text={entry.label} />
            </span>
            {entry.shortcut !== undefined && (
              <span className="app-menu-shortcut">{entry.shortcut}</span>
            )}
          </MenuItem>
        );
      })}
    </>
  );
}

export interface MenuBarProps {
  readonly context: MenuContext;
  readonly actions: MenuActions;
}

interface MenuPopupProps extends MenuBarProps {
  readonly name: MenuName;
}

function MenuPopup({ name, context, actions }: MenuPopupProps) {
  return (
    <MenuList
      label={plainLabel(menuTitle(name, context.t))}
      entries={buildMenu(name, context)}
      actions={actions}
    />
  );
}

/**
 * The main menu bar (UI-MENU, section 4). Alt plus an underlined letter opens a menu. Each menu
 * is built when it opens, so its enable states are current.
 */
export function MenuBar({ context, actions }: MenuBarProps) {
  const [openMenu, setOpenMenu] = useState<MenuName | null>(null);
  const { t } = context;

  useEffect(() => {
    const titles = MENU_NAMES.map((name) => ({
      name,
      key: splitAccessKey(menuTitle(name, t)).accessKey,
    }));
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const hit = titles.find(
        (title) => title.key !== undefined && event.code === `Key${title.key.toUpperCase()}`,
      );
      if (hit === undefined) return;
      event.preventDefault();
      setOpenMenu(hit.name);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [t]);

  return (
    <div className="app-menu-list">
      {MENU_NAMES.map((name) => (
        <MenuTrigger
          key={name}
          isOpen={openMenu === name}
          onOpenChange={(open) => setOpenMenu(open ? name : null)}
        >
          <Button className="app-menu-button">
            <AccessLabel text={menuTitle(name, t)} />
          </Button>
          <Popover className="app-popover" placement="bottom start">
            <MenuPopup name={name} context={context} actions={actions} />
          </Popover>
        </MenuTrigger>
      ))}
    </div>
  );
}
