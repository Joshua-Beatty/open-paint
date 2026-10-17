import type { ToolDescriptor } from "@openpaint/extension-api";
import { useTranslation } from "@openpaint/i18n/react";
import type { GpuPerformanceClass, SettingsStore } from "@openpaint/storage";
import { Icon, OverflowRow } from "@openpaint/ui";
import { useMemo, useSyncExternalStore } from "react";
import type { PenPresence } from "../settings/pen-input";
import { SettingsForm } from "../settings/SettingsForm";
import type { FormBlock } from "../settings/settings-schema";
import { useSetting } from "../settings/use-setting";
import { SWAP_ICON } from "./option-icons";
import { optionBlockOf, optionFieldsOf, toolShowsOption } from "./roster";
import { ShapeOptions } from "./ShapeOptions";
import { drawableShapeOrDefault, SHAPE_SETTING_PATH } from "./shape-catalog";
import { STRIP_ITEM } from "./strip-item";
import { FONT_FAMILY_PATH, TextOptions } from "./TextOptions";
import "./tools.css";

const WIDTH_PATH = "tools.selection.drawWidth";
const HEIGHT_PATH = "tools.selection.drawHeight";
const UNITS_PATH = "tools.selection.drawUnits";
const DRAW_TYPE_PATH = "tools.shapes.drawType";
const PRESSURE_PATH = "tools.brush.pressure";
const SELECTION_QUALITY_PATH = "tools.selection.renderingQuality";
const NO_PEN: PenPresence = { known: false, subscribe: () => () => undefined };

/** The outline-only options, which the Filled draw mode hides (TL-SHAPE-01). */
const OUTLINE_PATHS = ["tools.brush.size", "tools.pen.dashStyle"];

export interface ToolOptionsStripProps {
  readonly tool: ToolDescriptor;
  readonly settings: SettingsStore;
  readonly gpuPerformanceClass: GpuPerformanceClass;
  /** Commits the active tool's pending result. The Finish button shows for commit-capable tools. */
  readonly onFinish?: () => void;
  /** Opens another tool, for a shape in the picker that names one (TL-SHAPE-02). */
  readonly onSelectTool?: (id: string) => void;
  /** Whether a pen is in use. The pressure option shows only then; without this, it is hidden. */
  readonly pen?: PenPresence;
  /**
   * Whether the image has an active selection. Selection quality (TL-OPT-SELQ) only changes how
   * output is clipped at a selection's edge, so the bar shows it only then (owner request).
   * Settings › Tools always shows it. Defaults to shown.
   */
  readonly hasSelection?: boolean;
}

/** The option block without the font family, which the Text tool's font list replaces. */
function withoutFontFamily(block: FormBlock): FormBlock {
  return { ...block, fields: block.fields.filter((field) => field.path !== FONT_FAMILY_PATH) };
}

/**
 * The Shapes tool's block: its options, then the settings of the active shape (TL-SHAPE-01). The
 * outline-only options go when the draw mode is Filled, since a fill has no outline.
 */
function shapeBlock(block: FormBlock, stored: unknown, drawType: unknown): FormBlock {
  const shape = drawableShapeOrDefault(stored);
  const extra = optionFieldsOf(shape.settings.properties.map((property) => property.key));
  const outlined = drawType !== "Interior";
  const fields = block.fields.filter((field) => outlined || !OUTLINE_PATHS.includes(field.path));
  return { ...block, fields: [...fields, ...extra] };
}

/** The option block without the options at `paths`, which only show in some states. */
function without(block: FormBlock, paths: readonly string[]): FormBlock {
  if (paths.length === 0) return block;
  return { ...block, fields: block.fields.filter((field) => !paths.includes(field.path)) };
}

/** The option block without the Width, Height and units boxes, which only the fixed Draw modes show. */
function withoutSizeBoxes(block: FormBlock): FormBlock {
  const sizePaths = [WIDTH_PATH, HEIGHT_PATH, UNITS_PATH];
  return { ...block, fields: block.fields.filter((field) => !sizePaths.includes(field.path)) };
}

/**
 * The tool options bar for the active tool (TL-ROSTER-01, TL-FRAME-07). The controls are generated
 * from the tool's option block and stored under `tools.*`, so a choice persists across reloads
 * (08). Each tool shows only its own options. Rectangle Select's Width, Height and units boxes, and
 * the swap button beside them, show only for the Fixed Ratio and Fixed Size Draw modes (TL-SEL-RECT-01).
 */
export function ToolOptionsStrip({
  tool,
  settings,
  gpuPerformanceClass,
  onFinish,
  onSelectTool,
  pen = NO_PEN,
  hasSelection = true,
}: ToolOptionsStripProps) {
  const t = useTranslation();
  const penKnown = useSyncExternalStore(pen.subscribe, () => pen.known);
  const drawMode = useSetting(settings, "tools.selection.drawMode");
  const shapeStored = useSetting(settings, SHAPE_SETTING_PATH);
  const drawType = useSetting(settings, DRAW_TYPE_PATH);
  const sized = toolShowsOption(tool.id, "selection.drawWidth");
  const fixed = drawMode === "FixedRatio" || drawMode === "FixedSize";
  const textTool = tool.id === "text";
  const shapesTool = tool.id === "shapes";
  const block = useMemo(() => {
    const options = optionBlockOf(tool.id);
    const hidden = [
      ...(penKnown ? [] : [PRESSURE_PATH]),
      ...(hasSelection ? [] : [SELECTION_QUALITY_PATH]),
    ];
    const full = without(options, hidden);
    if (textTool) return withoutFontFamily(full);
    if (shapesTool) return shapeBlock(full, shapeStored, drawType);
    return sized && !fixed ? withoutSizeBoxes(full) : full;
  }, [tool.id, sized, fixed, textTool, shapesTool, shapeStored, drawType, penKnown, hasSelection]);

  const swapSize = () => {
    const width = settings.get(WIDTH_PATH);
    const height = settings.get(HEIGHT_PATH);
    if (width === undefined || height === undefined) return;
    settings.set(WIDTH_PATH, height);
    settings.set(HEIGHT_PATH, width);
  };

  return (
    <div className="tool-options-strip">
      <OverflowRow moreLabel={t("property.more")} className="tool-options-row">
        {textTool ? <TextOptions settings={settings} /> : null}
        {shapesTool ? <ShapeOptions settings={settings} onSelectTool={onSelectTool} /> : null}
        <SettingsForm
          key={tool.id}
          block={block}
          settings={settings}
          gpuPerformanceClass={gpuPerformanceClass}
          layout="inline"
        />
        {sized && fixed ? (
          <button
            type="button"
            className="tool-icon-button"
            aria-label={t("tool.selection.swap")}
            title={t("tool.selection.swap")}
            onClick={swapSize}
            {...STRIP_ITEM}
          >
            <Icon icon={SWAP_ICON} className="tool-strip-icon" />
          </button>
        ) : null}
      </OverflowRow>
      {tool.commitCapable && onFinish !== undefined ? (
        <button
          type="button"
          className="tool-finish"
          title={t("tool.finishTooltip")}
          onClick={onFinish}
        >
          {t("tool.finish")}
        </button>
      ) : null}
    </div>
  );
}
