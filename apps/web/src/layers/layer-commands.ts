import type { Document, Layer } from "@openpaint/document";
import type { BuiltInCommandId } from "../commands/catalog";
import type { ShortcutController } from "../commands/shortcuts";
import { nearestVisibleIndex } from "./layer-list";

export interface LayerCommandOptions {
  /** The image the layer commands act on, or undefined when no image is open. */
  readonly document: () => Document | undefined;
  /** Opens Layer Properties for the active layer (DOC-LYR-02). */
  readonly openProperties: () => void;
  /** Whether hiding a layer makes the nearest visible layer active (DOC-LYR-05o). */
  readonly autoSelectNearest: () => boolean;
}

/**
 * Shows or hides a layer (DOC-LYR-05o, UI-FTW-05). The layer becomes active first, since the
 * document changes only the active layer. Hiding can then select the nearest visible layer.
 */
export function setLayerVisible(
  doc: Document,
  layer: Layer,
  visible: boolean,
  autoSelectNearest: boolean,
): void {
  doc.setActiveLayer(layer);
  if (!doc.setActiveLayerProperties({ visible }) || visible || !autoSelectNearest) return;
  const target = nearestVisibleIndex(
    doc.layers.map((candidate) => candidate.visible),
    doc.layers.indexOf(layer),
  );
  const next = target === undefined ? undefined : doc.layers[target];
  if (next !== undefined) doc.setActiveLayer(next);
}

interface ActiveLayer {
  readonly doc: Document;
  readonly layer: Layer;
  /** The layer's position, where 0 is the bottom layer. */
  readonly index: number;
}

/**
 * Connects the Layers commands (DOC-LYR-05, UI-MENU-LAYERS) to the open image. The menus, the
 * Layers panel buttons and the shortcuts all run them through the controller, so the enable rules
 * apply the same way everywhere. Commands that need an active layer are disabled without one.
 * Returns the function that detaches every command.
 */
export function registerLayerCommands(
  controller: ShortcutController<BuiltInCommandId>,
  options: LayerCommandOptions,
): () => void {
  const active = (): ActiveLayer | undefined => {
    const doc = options.document();
    const layer = doc?.activeLayer;
    if (doc === undefined || layer === undefined) return undefined;
    return { doc, layer, index: doc.layers.indexOf(layer) };
  };
  const onActive = (
    id: BuiltInCommandId,
    when: (state: ActiveLayer) => boolean,
    run: (state: ActiveLayer) => void,
  ) =>
    controller.register(id, {
      run: () => {
        const state = active();
        if (state !== undefined) run(state);
      },
      enabled: () => {
        const state = active();
        return state !== undefined && when(state);
      },
    });
  /** Makes the layer at a position active. Navigation adds no history item (DOC-LYR-05p). */
  const navigation = (id: BuiltInCommandId, target: (state: ActiveLayer) => number | undefined) =>
    controller.register(id, {
      run: () => {
        const state = active();
        if (state === undefined) return;
        const index = target(state);
        const layer = index === undefined ? undefined : state.doc.layers[index];
        if (layer !== undefined) state.doc.setActiveLayer(layer);
      },
      enabled: () => {
        const state = active();
        return state !== undefined && target(state) !== undefined;
      },
    });
  const top = (state: ActiveLayer) => state.doc.layerCount - 1;
  const canMoveUp = (state: ActiveLayer) => state.index < top(state);
  const canMoveDown = (state: ActiveLayer) => state.index > 0;

  const releases = [
    onActive(
      "layers.add",
      () => true,
      ({ doc }) => {
        doc.addLayer();
      },
    ),
    onActive(
      "layers.delete",
      ({ doc }) => doc.layerCount > 1,
      ({ doc }) => {
        doc.deleteActiveLayer();
      },
    ),
    onActive(
      "layers.duplicate",
      () => true,
      ({ doc }) => {
        doc.duplicateActiveLayer();
      },
    ),
    onActive("layers.mergeDown", canMoveDown, ({ doc }) => {
      doc.mergeActiveLayerDown();
    }),
    onActive(
      "layers.toggleVisibility",
      () => true,
      ({ doc, layer }) => {
        setLayerVisible(doc, layer, !layer.visible, options.autoSelectNearest());
      },
    ),
    onActive(
      "layers.flipHorizontal",
      () => true,
      ({ doc }) => {
        doc.flipActiveLayerHorizontal();
      },
    ),
    onActive(
      "layers.flipVertical",
      () => true,
      ({ doc }) => {
        doc.flipActiveLayerVertical();
      },
    ),
    onActive(
      "layers.rotate180",
      () => true,
      ({ doc }) => {
        doc.rotateActiveLayer180();
      },
    ),
    navigation("layers.goTop", (state) => (canMoveUp(state) ? top(state) : undefined)),
    navigation("layers.goAbove", (state) => (canMoveUp(state) ? state.index + 1 : undefined)),
    navigation("layers.goBelow", (state) => (canMoveDown(state) ? state.index - 1 : undefined)),
    navigation("layers.goBottom", (state) => (canMoveDown(state) ? 0 : undefined)),
    onActive("layers.moveTop", canMoveUp, ({ doc }) => {
      doc.moveActiveLayerToTop();
    }),
    onActive("layers.moveUp", canMoveUp, ({ doc }) => {
      doc.moveActiveLayerUp();
    }),
    onActive("layers.moveDown", canMoveDown, ({ doc }) => {
      doc.moveActiveLayerDown();
    }),
    onActive("layers.moveBottom", canMoveDown, ({ doc }) => {
      doc.moveActiveLayerToBottom();
    }),
    onActive(
      "layers.properties",
      () => true,
      () => {
        options.openProperties();
      },
    ),
  ];
  return () => {
    for (const release of releases) release();
  };
}
