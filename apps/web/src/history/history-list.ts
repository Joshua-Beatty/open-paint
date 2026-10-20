import type { HistoryEntry } from "@openpaint/document";
import type { MessageId, Translate } from "@openpaint/i18n";

/**
 * The icon drawn beside a History step (UI-FTW-04): a general kind, or the icon of the tool that made
 * the step (`tool.<id>`, as in the Tools panel), owner request.
 */
export type HistoryIconKind =
  | "document"
  | "layer"
  | "image"
  | "selection"
  | "pixels"
  | "generic"
  | `tool.${string}`;

/** The icon of each fixed history name (DOC-HIS-03). Names with arguments use the layer prefix. */
const ICON_KEYS: readonly (readonly [MessageId, HistoryIconKind])[] = [
  ["history.newImage", "document"],
  ["history.pasteIntoNewImage", "document"],
  ["history.newLayer", "layer"],
  ["history.deleteLayer", "layer"],
  ["history.duplicateLayer", "layer"],
  ["history.mergeLayerDown", "layer"],
  ["history.moveLayerUp", "layer"],
  ["history.moveLayerDown", "layer"],
  ["history.moveLayerToTop", "layer"],
  ["history.moveLayerToBottom", "layer"],
  ["history.moveLayer", "layer"],
  ["history.swapLayer", "layer"],
  ["history.flipHorizontal", "layer"],
  ["history.flipVertical", "layer"],
  ["history.rotate180", "layer"],
  ["history.layerProperties", "layer"],
  ["history.flipHorizontalAll", "image"],
  ["history.flipVerticalAll", "image"],
  ["history.rotate90Cw", "image"],
  ["history.rotate90Ccw", "image"],
  ["history.rotate180All", "image"],
  ["history.canvasSize", "image"],
  ["history.resize", "image"],
  ["history.flatten", "image"],
  ["history.cropToSelection", "image"],
  ["history.selectAll", "selection"],
  ["history.deselect", "selection"],
  ["history.invertSelection", "selection"],
  ["history.editSelection", "selection"],
  ["history.rectangleSelect", "tool.rectangleSelect"],
  ["history.ellipseSelect", "tool.ellipseSelect"],
  ["history.lassoSelect", "tool.lassoSelect"],
  ["history.magicWand", "tool.magicWand"],
  ["history.finishMagicWand", "tool.magicWand"],
  ["history.moveOrigin", "tool.magicWand"],
  ["history.moveSelection", "tool.moveSelection"],
  ["history.resizeSelection", "tool.moveSelection"],
  ["history.rotateSelection", "tool.moveSelection"],
  ["history.finishSelection", "tool.moveSelection"],
  ["history.movePixels", "tool.moveSelectedPixels"],
  ["history.resizePixels", "tool.moveSelectedPixels"],
  ["history.rotatePixels", "tool.moveSelectedPixels"],
  ["history.moveRotationAnchor", "pixels"],
  ["history.finishPixels", "tool.moveSelectedPixels"],
  ["history.changeGammaMode", "tool.moveSelectedPixels"],
  ["history.paintBucket", "tool.paintBucket"],
  ["history.finishPaintBucket", "tool.paintBucket"],
  ["history.changeFill", "pixels"],
  ["history.changeBlendMode", "pixels"],
  ["history.toggleAntialiasing", "pixels"],
  ["history.changeTolerance", "selection"],
  ["history.changeToleranceAlphaMode", "selection"],
  ["history.changeFloodMode", "selection"],
  ["history.changeSampling", "selection"],
  ["history.changeSelectionMode", "selection"],
  ["history.changeSelectionQuality", "selection"],
  ["history.pasteSelection", "selection"],
  ["history.pasteSelectionAdd", "selection"],
  ["history.pasteSelectionSubtract", "selection"],
  ["history.pasteSelectionIntersect", "selection"],
  ["history.pasteSelectionXor", "selection"],
  ["history.cut", "pixels"],
  ["history.paste", "pixels"],
  ["history.eraseSelection", "pixels"],
  ["history.fillSelection", "pixels"],
  ["history.paintbrush", "tool.paintbrush"],
  ["history.eraser", "tool.eraser"],
  ["history.pencil", "tool.pencil"],
  ["history.recolor", "tool.recolor"],
  ["history.cloneStamp", "tool.cloneStamp"],
  ["history.drawLineCurve", "tool.lineCurve"],
  ["history.editLineCurve", "tool.lineCurve"],
  ["history.adjustLineCurve", "tool.lineCurve"],
  ["history.finishLineCurve", "tool.lineCurve"],
  ["history.changeCurveType", "tool.lineCurve"],
  ["history.changeBrushSize", "pixels"],
  ["history.changeDashStyle", "pixels"],
  ["history.changeStartCap", "tool.lineCurve"],
  ["history.changeEndCap", "tool.lineCurve"],
  ["history.drawShape", "tool.shapes"],
  ["history.editShape", "tool.shapes"],
  ["history.adjustShape", "tool.shapes"],
  ["history.finishShape", "tool.shapes"],
  ["history.changeToShape", "tool.shapes"],
  ["history.changeDrawMode", "tool.shapes"],
  ["history.gradient", "tool.gradient"],
  ["history.editGradient", "tool.gradient"],
  ["history.moveGradient", "tool.gradient"],
  ["history.finishGradient", "tool.gradient"],
  ["history.reverseColors", "tool.gradient"],
  ["history.changeGradientType", "tool.gradient"],
  ["history.changeRepeatType", "tool.gradient"],
  ["history.toggleAlphaMode", "tool.gradient"],
  ["history.text", "tool.text"],
];

/** A name with a shape placeholder, as the text before and after the name it stands for. */
interface HistoryTemplate {
  readonly before: string;
  readonly after: string;
  readonly kind: HistoryIconKind;
}

/** Stands in for the `{shape}` value, so a template's text can be split around it. */
const SHAPE_MARK = "\uE000";

/**
 * The lookup built once per language: exact names, the names with a shape placeholder (such as
 * "Draw {shape}"), and the prefix of "Layer {name}".
 */
export interface HistoryIcons {
  readonly kinds: ReadonlyMap<string, HistoryIconKind>;
  readonly templates: readonly HistoryTemplate[];
  readonly layerPrefix: string;
}

export function historyIcons(t: Translate): HistoryIcons {
  const kinds = new Map<string, HistoryIconKind>();
  const templates: HistoryTemplate[] = [];
  for (const [id, kind] of ICON_KEYS) {
    const text = t(id, { shape: SHAPE_MARK });
    const [before, after, ...rest] = text.split(SHAPE_MARK);
    if (before === undefined || after === undefined || rest.length > 0) kinds.set(text, kind);
    else templates.push({ before, after, kind });
  }
  return { kinds, templates, layerPrefix: t("history.layer", { name: "" }) };
}

/** The icon for a history name. Unknown names get the generic icon. */
export function historyIconFor(name: string, icons: HistoryIcons): HistoryIconKind {
  const exact = icons.kinds.get(name);
  if (exact !== undefined) return exact;
  const template = icons.templates.find(
    (candidate) =>
      name.length >= candidate.before.length + candidate.after.length &&
      name.startsWith(candidate.before) &&
      name.endsWith(candidate.after),
  );
  if (template !== undefined) return template.kind;
  return name.startsWith(icons.layerPrefix) ? "layer" : "generic";
}

/**
 * The position of the current step in the History list: the last applied item, where 0 is the
 * first item. Returns -1 when every item is undone.
 */
export function currentStep(entries: readonly HistoryEntry[]): number {
  return entries.findLastIndex((entry) => entry.applied);
}
