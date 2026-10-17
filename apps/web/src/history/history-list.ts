import type { HistoryEntry } from "@openpaint/document";
import type { MessageId, Translate } from "@openpaint/i18n";

/** The icon drawn beside a History step (UI-FTW-04). */
export type HistoryIconKind = "document" | "layer" | "image" | "selection" | "pixels" | "generic";

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
  ["history.rectangleSelect", "selection"],
  ["history.ellipseSelect", "selection"],
  ["history.lassoSelect", "selection"],
  ["history.magicWand", "selection"],
  ["history.finishMagicWand", "selection"],
  ["history.moveOrigin", "selection"],
  ["history.moveSelection", "selection"],
  ["history.resizeSelection", "selection"],
  ["history.rotateSelection", "selection"],
  ["history.finishSelection", "selection"],
  ["history.movePixels", "pixels"],
  ["history.resizePixels", "pixels"],
  ["history.rotatePixels", "pixels"],
  ["history.moveRotationAnchor", "pixels"],
  ["history.finishPixels", "pixels"],
  ["history.changeGammaMode", "pixels"],
  ["history.paintBucket", "pixels"],
  ["history.finishPaintBucket", "pixels"],
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
  ["history.paintbrush", "pixels"],
  ["history.eraser", "pixels"],
  ["history.pencil", "pixels"],
  ["history.recolor", "pixels"],
  ["history.cloneStamp", "pixels"],
  ["history.drawLineCurve", "pixels"],
  ["history.editLineCurve", "pixels"],
  ["history.adjustLineCurve", "pixels"],
  ["history.finishLineCurve", "pixels"],
  ["history.changeCurveType", "pixels"],
  ["history.changeBrushSize", "pixels"],
  ["history.changeDashStyle", "pixels"],
  ["history.changeStartCap", "pixels"],
  ["history.changeEndCap", "pixels"],
  ["history.drawShape", "pixels"],
  ["history.editShape", "pixels"],
  ["history.adjustShape", "pixels"],
  ["history.finishShape", "pixels"],
  ["history.changeToShape", "pixels"],
  ["history.changeDrawMode", "pixels"],
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
