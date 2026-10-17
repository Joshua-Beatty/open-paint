import {
  LayerBlendMode,
  type LayerProperties,
  MAX_LAYER_OPACITY,
  MIN_LAYER_OPACITY,
  truncateLayerName,
} from "@openpaint/document";
import type { MessageId } from "@openpaint/i18n";

/** The 14 layer blend modes in UI order, Normal first (DOC-BLD-01). */
export const LAYER_BLEND_MODE_ORDER: readonly LayerBlendMode[] = [
  LayerBlendMode.normal,
  LayerBlendMode.multiply,
  LayerBlendMode.additive,
  LayerBlendMode.colorBurn,
  LayerBlendMode.colorDodge,
  LayerBlendMode.reflect,
  LayerBlendMode.glow,
  LayerBlendMode.overlay,
  LayerBlendMode.difference,
  LayerBlendMode.negation,
  LayerBlendMode.lighten,
  LayerBlendMode.darken,
  LayerBlendMode.screen,
  LayerBlendMode.xor,
];

export const BLEND_MODE_MESSAGES: Readonly<Record<LayerBlendMode, MessageId>> = {
  [LayerBlendMode.normal]: "blend.normal",
  [LayerBlendMode.multiply]: "blend.multiply",
  [LayerBlendMode.additive]: "blend.additive",
  [LayerBlendMode.colorBurn]: "blend.colorBurn",
  [LayerBlendMode.colorDodge]: "blend.colorDodge",
  [LayerBlendMode.reflect]: "blend.reflect",
  [LayerBlendMode.glow]: "blend.glow",
  [LayerBlendMode.overlay]: "blend.overlay",
  [LayerBlendMode.difference]: "blend.difference",
  [LayerBlendMode.negation]: "blend.negation",
  [LayerBlendMode.lighten]: "blend.lighten",
  [LayerBlendMode.darken]: "blend.darken",
  [LayerBlendMode.screen]: "blend.screen",
  [LayerBlendMode.xor]: "blend.xor",
};

/** The values of the Layer Properties dialog before OK (DOC-LYR-02). */
export interface LayerDraft {
  readonly name: string;
  readonly visible: boolean;
  readonly opacity: number;
  readonly blendMode: LayerBlendMode;
}

export function layerDraft(properties: LayerProperties): LayerDraft {
  return {
    name: properties.name,
    visible: properties.visible,
    opacity: properties.opacity,
    blendMode: properties.blendMode,
  };
}

/**
 * The full property set of a draft, with the name truncated and the opacity clamped. This is what
 * the canvas shows while the dialog is open (live preview), and it is the same as the committed value.
 */
export function draftProperties(draft: LayerDraft): LayerProperties {
  return {
    name: truncateLayerName(draft.name),
    visible: draft.visible,
    opacity: Math.min(MAX_LAYER_OPACITY, Math.max(MIN_LAYER_OPACITY, Math.round(draft.opacity))),
    blendMode: draft.blendMode,
  };
}

/**
 * The properties that differ from `current`, ready for `Document.setActiveLayerProperties`. The
 * name is truncated to the layer name limit (DOC-LYR-01), and the opacity is clamped to its range.
 */
export function layerPropertyPatch(
  current: LayerProperties,
  draft: LayerDraft,
): Partial<LayerProperties> {
  const patch: { -readonly [K in keyof LayerProperties]?: LayerProperties[K] } = {};
  const next = draftProperties(draft);
  if (next.name !== current.name) patch.name = next.name;
  if (next.visible !== current.visible) patch.visible = next.visible;
  if (next.opacity !== current.opacity) patch.opacity = next.opacity;
  if (next.blendMode !== current.blendMode) patch.blendMode = next.blendMode;
  return patch;
}
