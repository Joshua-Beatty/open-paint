import type { Document } from "@openpaint/document";
import { useTranslation } from "@openpaint/i18n/react";
import { TooltipTrigger } from "@openpaint/ui";
import { useState, useSyncExternalStore } from "react";
import {
  Button,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  ProgressBar,
  Slider,
  SliderThumb,
  SliderTrack,
  Tooltip,
} from "react-aria-components";
import type { BuiltInCommandId } from "../commands/catalog";
import type { ShortcutController } from "../commands/shortcuts";
import { UNIT_COMMAND } from "./status-commands";
import {
  cursorText,
  imagePixelAt,
  imageSizeText,
  MEASURE_UNITS,
  type MeasureUnit,
  selectionText,
  UNIT_LABEL,
  unitAbbreviation,
  ZOOM_SLIDER_STEPS,
  zoomFromSliderValue,
  zoomPercent,
  zoomSliderValue,
} from "./status-model";
import type { StatusStore } from "./status-store";
import { ZoomEntry } from "./ZoomEntry";

export interface StatusBarProps {
  readonly store: StatusStore;
  /** The active image, or undefined when none is open. */
  readonly doc: Document | undefined;
  /** The display unit (UI-VIEW-05). */
  readonly units: MeasureUnit;
  /** Runs the zoom and unit commands, so their enable rules match the menus and keys. */
  readonly commands: ShortcutController<BuiltInCommandId>;
  /** Sets the zoom ratio from the zoom box and the slider (UI-SB-03). */
  readonly onZoom: (ratio: number) => void;
}

/**
 * The status bar (UI-SB-01): the context text with its live region, the progress bar, the image
 * size, the cursor position, the units menu, the zoom controls and the zoom slider.
 */
export function StatusBar({ store, doc, units, commands, onZoom }: StatusBarProps) {
  const t = useTranslation();
  return (
    <div className="app-status-content">
      <StatusContext store={store} doc={doc} units={units} />
      <StatusProgress store={store} />
      <span className="app-status-separator" aria-hidden="true" />
      {doc !== undefined && (
        <span className="app-status-text" title={t("status.imageSizeTip")}>
          {imageSizeText(doc.width, doc.height, doc.resolution, units, t)}
        </span>
      )}
      <span className="app-status-separator" aria-hidden="true" />
      <CursorReadout store={store} doc={doc} units={units} />
      <MenuTrigger>
        <Button className="app-status-button" aria-label={t("status.units")}>
          {unitAbbreviation(units, t)}
        </Button>
        <Popover className="app-popover" placement="top end">
          <Menu
            className="app-menu"
            selectionMode="single"
            selectedKeys={[units]}
            aria-label={t("status.units")}
          >
            {MEASURE_UNITS.map((unit) => (
              <MenuItem
                key={unit}
                id={unit}
                className="app-menu-item"
                isDisabled={!commands.isEnabled(UNIT_COMMAND[unit])}
                onAction={() => commands.invoke(UNIT_COMMAND[unit])}
              >
                <span className="app-menu-label">{t(UNIT_LABEL[unit])}</span>
              </MenuItem>
            ))}
          </Menu>
        </Popover>
      </MenuTrigger>
      <span className="app-status-separator" aria-hidden="true" />
      <ZoomControls store={store} commands={commands} onZoom={onZoom} />
    </div>
  );
}

/**
 * The context text: a tool's hint, or the selection's size. Each part of the status bar reads only
 * the fields it shows, so a pointer move re-renders the cursor readout alone (L3).
 */
function StatusContext({ store, doc, units }: Pick<StatusBarProps, "store" | "doc" | "units">) {
  const t = useTranslation();
  const hint = useSyncExternalStore(store.subscribe, () => store.state.hint);
  // A selection preview re-renders only this text, not the shell around it.
  const current = useSyncExternalStore(
    (listener) => doc?.subscribe((change) => change === "selection" && listener()) ?? (() => {}),
    () => doc?.selection,
  );
  const selection =
    hint === undefined && doc !== undefined && current !== undefined && !current.isEmpty
      ? selectionText(current, doc.resolution, units, t)
      : undefined;
  return (
    <div className="app-status-context" aria-live="polite">
      {hint?.icon}
      {hint?.text ?? selection ?? ""}
    </div>
  );
}

/** The image pixel under the pointer, in the display unit. */
function CursorReadout({ store, doc, units }: Pick<StatusBarProps, "store" | "doc" | "units">) {
  const t = useTranslation();
  const layout = useSyncExternalStore(store.subscribe, () => store.state.layout);
  const pointer = useSyncExternalStore(store.subscribe, () => store.state.pointer);
  const pixel =
    layout !== undefined && pointer !== undefined ? imagePixelAt(layout, pointer) : undefined;
  const cursor =
    doc !== undefined && pixel !== undefined ? cursorText(pixel, doc.resolution, units, t) : "";
  return (
    <span className="app-status-text" title={t("status.cursorTip")}>
      {cursor}
    </span>
  );
}

function StatusProgress({ store }: Pick<StatusBarProps, "store">) {
  const t = useTranslation();
  const progress = useSyncExternalStore(store.subscribe, () => store.state.progress);
  if (progress === undefined) return null;
  return (
    <div className="app-status-progress">
      <span className="app-status-separator" aria-hidden="true" />
      <ProgressBar
        aria-label={t("status.progress")}
        value={progress.value}
        isIndeterminate={progress.value === undefined}
        className="app-status-progress-bar"
      >
        <div
          className={
            progress.value === undefined
              ? "app-status-progress-fill app-status-progress-indeterminate"
              : "app-status-progress-fill"
          }
          style={progress.value === undefined ? undefined : { width: `${progress.value}%` }}
        />
      </ProgressBar>
      {progress.value !== undefined && (
        <span className="app-status-text">
          {t("status.progressPercent", { percent: String(Math.round(progress.value)) })}
        </span>
      )}
    </div>
  );
}

/** The zoom box, the fit toggle, the zoom buttons and the slider. They re-render on zoom changes. */
function ZoomControls({
  store,
  commands,
  onZoom,
}: Pick<StatusBarProps, "store" | "commands" | "onZoom">) {
  const t = useTranslation();
  const zoom = useSyncExternalStore(store.subscribe, () => store.state.layout?.zoom);
  const mode = useSyncExternalStore(store.subscribe, () => store.state.layout?.mode);
  const [entryOpen, setEntryOpen] = useState(false);
  const canZoom = commands.isEnabled("view.zoomIn");
  const fitting = mode !== "fixed";
  const toggleTip = fitting ? t("status.actualSize") : t("status.zoomToWindow");
  const toggleLabel = fitting ? t("status.actualSizeShort") : t("status.zoomToWindowShort");
  const percent = zoom === undefined ? undefined : zoomPercent(zoom);
  return (
    <>
      {entryOpen && percent !== undefined ? (
        <div className="app-status-zoom-wrap">
          <ZoomEntry
            percent={percent}
            onApply={(ratio) => {
              setEntryOpen(false);
              onZoom(ratio);
            }}
            onCancel={() => setEntryOpen(false)}
          />
        </div>
      ) : (
        <Button
          className="app-status-button app-status-zoom"
          isDisabled={!canZoom || percent === undefined}
          onPress={() => setEntryOpen(true)}
        >
          {percent === undefined ? "" : t("status.zoomPercent", { percent: String(percent) })}
        </Button>
      )}
      <TooltipTrigger delay={500}>
        <Button
          className="app-status-button"
          isDisabled={!canZoom}
          onPress={() => commands.invoke(fitting ? "view.actualSize" : "view.zoomToWindow")}
          aria-label={toggleTip}
        >
          {toggleLabel}
        </Button>
        <Tooltip className="app-tooltip">{toggleTip}</Tooltip>
      </TooltipTrigger>
      <span className="app-status-separator" aria-hidden="true" />
      <TooltipTrigger delay={500}>
        <Button
          className="app-status-button"
          isDisabled={!canZoom}
          onPress={() => commands.invoke("view.zoomOut")}
          aria-label={t("status.zoomOut")}
        >
          {t("status.zoomOutGlyph")}
        </Button>
        <Tooltip className="app-tooltip">{t("status.zoomOut")}</Tooltip>
      </TooltipTrigger>
      <Slider
        aria-label={t("status.zoomSlider")}
        className="app-status-zoom-slider"
        minValue={0}
        maxValue={ZOOM_SLIDER_STEPS}
        step={1}
        value={zoom === undefined ? 0 : zoomSliderValue(zoom)}
        isDisabled={!canZoom}
        onChange={(value) => onZoom(zoomFromSliderValue(value))}
      >
        <SliderTrack className="app-status-slider-track">
          <SliderThumb />
        </SliderTrack>
      </Slider>
      <TooltipTrigger delay={500}>
        <Button
          className="app-status-button"
          isDisabled={!canZoom}
          onPress={() => commands.invoke("view.zoomIn")}
          aria-label={t("status.zoomIn")}
        >
          {t("status.zoomInGlyph")}
        </Button>
        <Tooltip className="app-tooltip">{t("status.zoomIn")}</Tooltip>
      </TooltipTrigger>
    </>
  );
}
