import type { MessageId } from "@openpaint/i18n";
import { useTranslation } from "@openpaint/i18n/react";
import { Icon, TooltipTrigger } from "@openpaint/ui";
import { type DragEvent, type Key, type MouseEvent, useCallback, useEffect, useState } from "react";
import {
  Button,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  Separator,
  ToggleButton,
  Tooltip,
} from "react-aria-components";
import type { BuiltInCommandId } from "../commands/catalog";
import type { ShortcutController } from "../commands/shortcuts";
import { SWAP_ICON } from "../tools/option-icons";
import { ColorEditor } from "./ColorEditor";
import { argbHex, BLACK, swatchBackground, WHITE } from "./color-math";
import { DeleteDialog, PaletteNameDialog, ReplaceDialog } from "./PaletteDialogs";
import { PALETTE_EXTENSION } from "./palette";
import { downloadText, isPaletteFile, pickPaletteFiles, readPaletteFiles } from "./palette-files";
import type { PaletteStorage } from "./palette-library";
import {
  type ColorSettings,
  PRIMARY_COLOR_PATH,
  SECONDARY_COLOR_PATH,
  usePalettes,
  useStoredColor,
} from "./use-colors";

type ColorTarget = "primary" | "secondary";
type PaletteAction = "save" | "rename" | "delete";

/** A palette dialog and the user palette it acts on. */
interface PaletteDialog {
  readonly action: PaletteAction;
  readonly name: string;
}

/** The context menu of one user palette entry, opened at the pointer (DOC-COL-04). */
interface EntryMenu {
  readonly name: string;
  readonly x: number;
  readonly y: number;
}

/** The blink interval of the palette in add mode (UI-FTW-06). */
const ADD_MODE_BLINK_MS = 500;
const PALETTE_MENU_PREFIX = "palette:";
/**
 * The palette's 96 colors are 6 rows of 16, as the default palette is laid out (UI-FTW-06). The
 * swatches share the panel's width, up to this size in CSS px, which keeps the compact panel at
 * its minimum height in a wide sidebar.
 */
export const PALETTE_COLUMNS = 16;
const MAX_SWATCH = 16;

export interface ColorsPanelProps {
  readonly settings: ColorSettings;
  readonly storage: PaletteStorage;
  readonly commands: ShortcutController<BuiltInCommandId>;
  /** Whether the expanded (More) mode is on. It is stored in the layout settings. */
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  /** Returns keyboard focus to the canvas after a pointer click in the panel (UI-FTW-01). */
  readonly onRelinquish: () => void;
}

/**
 * The Colors panel (UI-FTW-06, DOC-COL-01, DOC-COL-02, DOC-COL-04). It shows the primary and
 * secondary colors, the palette, and the palette menu. The expanded mode adds the wheel and the
 * sliders. Palette files dropped on the panel are imported.
 */
export function ColorsPanel({
  settings,
  storage,
  commands,
  expanded,
  onExpandedChange,
  onRelinquish,
}: ColorsPanelProps) {
  const t = useTranslation();
  const [primary, setPrimary] = useStoredColor(settings, PRIMARY_COLOR_PATH, BLACK);
  const [secondary, setSecondary] = useStoredColor(settings, SECONDARY_COLOR_PATH, WHITE);
  const [target, setTarget] = useState<ColorTarget>("primary");
  const palettes = usePalettes(storage, settings);
  const [addMode, setAddMode] = useState(false);
  const [blinkOn, setBlinkOn] = useState(false);
  const [dialog, setDialog] = useState<PaletteDialog | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [paletteMenuOpen, setPaletteMenuOpen] = useState(false);
  const [entryMenu, setEntryMenu] = useState<EntryMenu | null>(null);

  const current = target === "primary" ? primary : secondary;
  const setCurrent = target === "primary" ? setPrimary : setSecondary;
  const setOther = target === "primary" ? setSecondary : setPrimary;
  const swap = useCallback(() => {
    setPrimary(secondary);
    setSecondary(primary);
  }, [primary, secondary, setPrimary, setSecondary]);
  const resetColors = useCallback(() => {
    setPrimary(BLACK);
    setSecondary(WHITE);
  }, [setPrimary, setSecondary]);

  useEffect(() => {
    const detach = [
      commands.register("tools.toggleColorTarget", {
        run: () => setTarget((previous) => (previous === "primary" ? "secondary" : "primary")),
      }),
      commands.register("tools.swapColors", { run: swap }),
    ];
    return () => {
      for (const release of detach) release();
    };
  }, [commands, swap]);

  useEffect(() => {
    if (!addMode) return undefined;
    const timer = setInterval(() => setBlinkOn((on) => !on), ADD_MODE_BLINK_MS);
    return () => {
      clearInterval(timer);
      setBlinkOn(false);
    };
  }, [addMode]);

  const importPalettes = async (files: File[]) => {
    await palettes.importFiles(await readPaletteFiles(files));
  };

  const exportName =
    palettes.state.current === "" ? t("colors.palette.default") : palettes.state.current;

  const onMenuAction = (key: Key) => {
    const id = String(key);
    if (id.startsWith(PALETTE_MENU_PREFIX)) {
      void palettes.select(id.slice(PALETTE_MENU_PREFIX.length));
      return;
    }
    switch (id) {
      case "save":
        setDialog({ action: "save", name: palettes.state.current });
        return;
      case "rename":
        setDialog({ action: "rename", name: palettes.state.current });
        return;
      case "delete":
        setDialog({ action: "delete", name: palettes.state.current });
        return;
      case "import":
        void pickPaletteFiles().then(importPalettes);
        return;
      case "export":
        downloadText(`${exportName}${PALETTE_EXTENSION}`, palettes.exportText());
        return;
      case "reset":
        void palettes.select("");
    }
  };

  const onEntryAction = (key: Key) => {
    const menu = entryMenu;
    setEntryMenu(null);
    if (menu === null) return;
    if (key === "rename" || key === "delete") setDialog({ action: key, name: menu.name });
  };

  const onSwatch = (index: number, event: MouseEvent<HTMLButtonElement>) => {
    const color = palettes.state.colors[index];
    if (color === undefined) return;
    if (addMode) {
      palettes.setColor(index, current);
      setAddMode(false);
    } else if (event.shiftKey) {
      palettes.setColor(index, WHITE);
    } else {
      setCurrent(color);
    }
    if (event.detail > 0) onRelinquish();
  };

  const tip = (name: MessageId, id: BuiltInCommandId) => {
    const labels = commands.labels(id);
    const shortcut = labels.shortcuts[0];
    return shortcut === undefined ? t(name) : t("colors.tip.shortcut", { name: t(name), shortcut });
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setDropActive(false);
    const files = Array.from(event.dataTransfer.files).filter(isPaletteFile);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    void importPalettes(files);
  };

  const dialogOpen = (action: PaletteAction) => dialog?.action === action;
  const nameDialogOpen = dialogOpen("save") || dialogOpen("rename");

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the panel accepts palette files dropped on it (UI-FTW-06); it is not a control
    <div
      className={dropActive ? "colors-panel is-drop-target" : "colors-panel"}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.items).some((item) => item.kind === "file")) return;
        event.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={onDrop}
    >
      <div className="colors-top">
        <div className="color-pair">
          <ToggleButton
            className="color-chip is-secondary"
            aria-label={t("colors.secondary")}
            isSelected={target === "secondary"}
            onChange={(selected) => {
              if (selected) setTarget("secondary");
            }}
            style={{ background: swatchBackground(secondary) }}
          />
          <ToggleButton
            className="color-chip is-primary"
            aria-label={t("colors.primary")}
            isSelected={target === "primary"}
            onChange={(selected) => {
              if (selected) setTarget("primary");
            }}
            style={{ background: swatchBackground(primary) }}
          />
        </div>
        <div className="colors-controls">
          <div className="colors-controls-row">
            <TooltipTrigger>
              <Button
                className="color-icon-button"
                aria-label={tip("colors.swap", "tools.swapColors")}
                onPress={swap}
              >
                <Icon icon={SWAP_ICON} className="color-icon" />
              </Button>
              <Tooltip>{tip("colors.swap", "tools.swapColors")}</Tooltip>
            </TooltipTrigger>
            <TooltipTrigger>
              <Button
                className="color-icon-button"
                aria-label={t("colors.reset")}
                onPress={resetColors}
              >
                <svg aria-hidden="true" viewBox="0 0 16 16" className="color-icon">
                  <rect x="2" y="2" width="7" height="7" fill="#000" />
                  <rect x="7" y="7" width="7" height="7" fill="#fff" stroke="#000" />
                </svg>
              </Button>
              <Tooltip>{t("colors.reset")}</Tooltip>
            </TooltipTrigger>
            <Button
              className="color-tool-button color-more-button"
              aria-expanded={expanded}
              onPress={() => onExpandedChange(!expanded)}
            >
              {expanded ? t("colors.less") : t("colors.more")}
            </Button>
          </div>
          <div className="colors-palette-toolbar">
            <ToggleButton
              className="color-tool-button color-add-button"
              aria-label={t("colors.addColor")}
              isSelected={addMode}
              onChange={setAddMode}
              style={{ background: swatchBackground(current) }}
            >
              +
            </ToggleButton>
            <MenuTrigger isOpen={paletteMenuOpen} onOpenChange={setPaletteMenuOpen}>
              <Button className="color-tool-button">{t("colors.palettes")}</Button>
              <Popover className="app-popover" placement="bottom start">
                <Menu className="app-menu" onAction={onMenuAction}>
                  {palettes.state.names.map((name) => (
                    <MenuItem
                      key={name}
                      id={`${PALETTE_MENU_PREFIX}${name}`}
                      className="app-menu-item"
                    >
                      {/* biome-ignore lint/a11y/noStaticElementInteractions: the context menu opens from the menu item's label (DOC-COL-04) */}
                      <span
                        className="app-menu-label"
                        onContextMenu={(event) => {
                          event.preventDefault();
                          setPaletteMenuOpen(false);
                          setEntryMenu({ name, x: event.clientX, y: event.clientY });
                        }}
                      >
                        {palettes.state.current === name ? `✓ ${name}` : name}
                      </span>
                    </MenuItem>
                  ))}
                  <Separator className="app-menu-separator" />
                  <MenuItem id="save" className="app-menu-item">
                    <span className="app-menu-label">{t("colors.menu.saveAs")}</span>
                  </MenuItem>
                  <MenuItem
                    id="rename"
                    className="app-menu-item"
                    isDisabled={palettes.state.current === ""}
                  >
                    <span className="app-menu-label">{t("colors.menu.rename")}</span>
                  </MenuItem>
                  <MenuItem
                    id="delete"
                    className="app-menu-item"
                    isDisabled={palettes.state.current === ""}
                  >
                    <span className="app-menu-label">{t("colors.menu.delete")}</span>
                  </MenuItem>
                  <Separator className="app-menu-separator" />
                  <MenuItem id="import" className="app-menu-item">
                    <span className="app-menu-label">{t("colors.menu.import")}</span>
                  </MenuItem>
                  <MenuItem id="export" className="app-menu-item">
                    <span className="app-menu-label">{t("colors.menu.export")}</span>
                  </MenuItem>
                  <Separator className="app-menu-separator" />
                  <MenuItem id="reset" className="app-menu-item">
                    <span className="app-menu-label">{t("colors.menu.reset")}</span>
                  </MenuItem>
                </Menu>
              </Popover>
            </MenuTrigger>
            <span className="color-palette-name">
              {palettes.state.current === "" ? t("colors.palette.default") : palettes.state.current}
            </span>
          </div>
        </div>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: the palette is a grid of swatch buttons, which a fieldset would restyle */}
      <div
        className={
          addMode
            ? blinkOn
              ? "color-palette is-adding is-blink"
              : "color-palette is-adding"
            : "color-palette"
        }
        role="group"
        aria-label={t("colors.palette.label")}
        style={{ gridTemplateColumns: `repeat(${PALETTE_COLUMNS}, minmax(0, ${MAX_SWATCH}px))` }}
      >
        {palettes.state.colors.map((color, index) => (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: a palette slot is identified by its position
            key={index}
            type="button"
            className="color-palette-swatch"
            style={{ background: swatchBackground(color) }}
            title={argbHex(color)}
            aria-label={t("colors.palette.swatch", { number: index + 1, hex: argbHex(color) })}
            onClick={(event) => onSwatch(index, event)}
            onContextMenu={(event) => {
              event.preventDefault();
              setOther(color);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Delete") return;
              event.preventDefault();
              palettes.setColor(index, WHITE);
            }}
          />
        ))}
      </div>
      {expanded && (
        <ColorEditor
          color={current}
          other={target === "primary" ? secondary : primary}
          onChange={setCurrent}
        />
      )}
      {entryMenu !== null && (
        <MenuTrigger
          isOpen
          onOpenChange={(open) => {
            if (!open) setEntryMenu(null);
          }}
        >
          <Button
            aria-label={t("colors.entry.menu")}
            className="palette-entry-anchor"
            style={{
              position: "fixed",
              left: entryMenu.x,
              top: entryMenu.y,
              width: 1,
              height: 1,
              padding: 0,
              border: 0,
              opacity: 0,
              pointerEvents: "none",
            }}
          />
          <Popover className="app-popover" placement="bottom start">
            <Menu className="app-menu" onAction={onEntryAction} autoFocus="first">
              <MenuItem id="rename" className="app-menu-item">
                <span className="app-menu-label">{t("colors.entry.rename")}</span>
              </MenuItem>
              <MenuItem id="delete" className="app-menu-item">
                <span className="app-menu-label">{t("colors.entry.delete")}</span>
              </MenuItem>
            </Menu>
          </Popover>
        </MenuTrigger>
      )}
      <PaletteNameDialog
        isOpen={nameDialogOpen}
        mode={dialogOpen("rename") ? "rename" : "save"}
        names={palettes.state.names}
        initialName={dialog?.action === "rename" ? dialog.name : ""}
        onClose={() => setDialog(null)}
        onSubmit={(name) => {
          const submitted = dialog;
          setDialog(null);
          if (submitted?.action === "rename") void palettes.rename(submitted.name, name);
          else void palettes.save(name);
        }}
      />
      <DeleteDialog
        isOpen={dialogOpen("delete")}
        name={dialog?.name ?? ""}
        onClose={() => setDialog(null)}
        onConfirm={() => {
          const submitted = dialog;
          setDialog(null);
          if (submitted !== null) void palettes.remove(submitted.name);
        }}
      />
      <ReplaceDialog name={palettes.replacing} onAnswer={palettes.answerReplace} />
    </div>
  );
}
