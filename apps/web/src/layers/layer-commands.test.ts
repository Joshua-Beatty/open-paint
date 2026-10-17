/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document, type Layer } from "@openpaint/document";
import { beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { BUILT_IN_REGISTRY, type BuiltInCommandId } from "../commands/catalog";
import { ShortcutController } from "../commands/shortcuts";
import { registerLayerCommands, setLayerVisible } from "./layer-commands";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

interface Setup {
  readonly controller: ShortcutController<BuiltInCommandId>;
  readonly openProperties: Mock<() => void>;
  readonly doc: Document;
  readonly autoSelect: { value: boolean };
}

/** A three-layer image: Background at the bottom, then two layers above it. */
function setup(): Setup {
  const doc = Document.createBlank({ width: 4, height: 4 });
  doc.addLayer();
  doc.addLayer();
  const controller = new ShortcutController(BUILT_IN_REGISTRY, "other");
  const openProperties = vi.fn<() => void>();
  const autoSelect = { value: false };
  registerLayerCommands(controller, {
    document: () => doc,
    openProperties,
    autoSelectNearest: () => autoSelect.value,
  });
  return { controller, openProperties, doc, autoSelect };
}

function namesOf(doc: Document): string[] {
  return doc.layers.map((layer) => layer.name);
}

describe("layer commands", () => {
  let state: Setup;

  beforeEach(() => {
    state = setup();
  });

  it("adds a layer directly above the active one and makes it active (DOC-LYR-05a)", () => {
    const { controller, doc } = state;
    doc.setActiveLayer(doc.layers[0] as Layer);
    expect(controller.invoke("layers.add")).toBe(true);
    expect(doc.layerCount).toBe(4);
    expect(doc.layers[1]).toBe(doc.activeLayer);
    doc.dispose();
  });

  it("deletes the active layer, but never the last one (DOC-LYR-05b)", () => {
    const { controller, doc } = state;
    expect(controller.invoke("layers.delete")).toBe(true);
    expect(doc.layerCount).toBe(2);
    while (doc.layerCount > 1) controller.invoke("layers.delete");
    expect(controller.isEnabled("layers.delete")).toBe(false);
    expect(controller.invoke("layers.delete")).toBe(false);
    expect(doc.layerCount).toBe(1);
    doc.dispose();
  });

  it("duplicates the active layer above itself (DOC-LYR-05c)", () => {
    const { controller, doc } = state;
    const names = namesOf(doc);
    controller.invoke("layers.duplicate");
    expect(doc.layerCount).toBe(4);
    expect(doc.layers[3]).toBe(doc.activeLayer);
    expect(namesOf(doc)[3]).toBe(names[2]);
    doc.dispose();
  });

  it("merges down only when a layer is below the active one (DOC-LYR-05d)", () => {
    const { controller, doc } = state;
    doc.setActiveLayer(doc.layers[0] as Layer);
    expect(controller.isEnabled("layers.mergeDown")).toBe(false);
    doc.setActiveLayer(doc.layers[2] as Layer);
    expect(controller.invoke("layers.mergeDown")).toBe(true);
    expect(doc.layerCount).toBe(2);
    doc.dispose();
  });

  it("toggles the active layer's visibility (DOC-LYR-05o)", () => {
    const { controller, doc } = state;
    const layer = doc.activeLayer as Layer;
    controller.invoke("layers.toggleVisibility");
    expect(layer.visible).toBe(false);
    controller.invoke("layers.toggleVisibility");
    expect(layer.visible).toBe(true);
    doc.dispose();
  });

  it("selects the nearest visible layer after hiding when the setting is on (DOC-LYR-05o)", () => {
    const { doc, autoSelect } = state;
    const [bottom, middle, top] = doc.layers as [Layer, Layer, Layer];
    doc.setActiveLayer(middle);
    autoSelect.value = true;
    setLayerVisible(doc, middle, false, true);
    expect(doc.activeLayer).toBe(top);
    setLayerVisible(doc, top, false, true);
    expect(doc.activeLayer).toBe(bottom);
    doc.dispose();
  });

  it("keeps the active layer when hiding with the setting off", () => {
    const { doc } = state;
    const [, middle] = doc.layers as [Layer, Layer];
    setLayerVisible(doc, middle, false, false);
    expect(doc.activeLayer).toBe(middle);
    doc.dispose();
  });

  it("activates a layer when its row's checkbox hides it, since the document changes the active layer", () => {
    const { doc } = state;
    const [bottom] = doc.layers as [Layer];
    setLayerVisible(doc, bottom, false, false);
    expect(bottom.visible).toBe(false);
    expect(doc.activeLayer).toBe(bottom);
    doc.dispose();
  });

  it("moves between layers without a history item (DOC-LYR-05p)", () => {
    const { controller, doc } = state;
    doc.setActiveLayer(doc.layers[1] as Layer);
    const entries = doc.history.entries.length;
    expect(controller.invoke("layers.goTop")).toBe(true);
    expect(doc.activeLayer).toBe(doc.layers[2]);
    expect(controller.isEnabled("layers.goAbove")).toBe(false);
    expect(controller.invoke("layers.goBottom")).toBe(true);
    expect(doc.activeLayer).toBe(doc.layers[0]);
    expect(controller.isEnabled("layers.goBelow")).toBe(false);
    expect(controller.invoke("layers.goAbove")).toBe(true);
    expect(doc.activeLayer).toBe(doc.layers[1]);
    expect(controller.invoke("layers.goBelow")).toBe(true);
    expect(doc.activeLayer).toBe(doc.layers[0]);
    expect(doc.history.entries.length).toBe(entries);
    doc.dispose();
  });

  it("moves the active layer up, down, to the top and to the bottom (DOC-LYR-05j to 05m)", () => {
    const { controller, doc } = state;
    const bottom = doc.layers[0] as Layer;
    doc.setActiveLayer(bottom);
    expect(controller.isEnabled("layers.moveDown")).toBe(false);
    expect(controller.invoke("layers.moveTop")).toBe(true);
    expect(doc.layers[2]).toBe(bottom);
    expect(controller.invoke("layers.moveDown")).toBe(true);
    expect(doc.layers[1]).toBe(bottom);
    expect(controller.invoke("layers.moveUp")).toBe(true);
    expect(doc.layers[2]).toBe(bottom);
    expect(controller.invoke("layers.moveBottom")).toBe(true);
    expect(doc.layers[0]).toBe(bottom);
    expect(controller.isEnabled("layers.moveBottom")).toBe(false);
    doc.dispose();
  });

  it("flips and rotates the active layer as one history item each (DOC-LYR-05f to 05h)", () => {
    const { controller, doc } = state;
    const before = doc.history.entries.length;
    expect(controller.invoke("layers.flipHorizontal")).toBe(true);
    expect(controller.invoke("layers.flipVertical")).toBe(true);
    expect(controller.invoke("layers.rotate180")).toBe(true);
    expect(doc.history.entries.length).toBe(before + 3);
    doc.dispose();
  });

  it("asks for Layer Properties on the active layer (DOC-LYR-05n)", () => {
    const { controller, openProperties, doc } = state;
    expect(controller.invoke("layers.properties")).toBe(true);
    expect(openProperties).toHaveBeenCalledTimes(1);
    doc.dispose();
  });

  it("disables every layer command when no image is open", () => {
    const controller = new ShortcutController(BUILT_IN_REGISTRY, "other");
    const openProperties = vi.fn<() => void>();
    registerLayerCommands(controller, {
      document: () => undefined,
      openProperties,
      autoSelectNearest: () => false,
    });
    expect(controller.isEnabled("layers.add")).toBe(false);
    expect(controller.invoke("layers.properties")).toBe(false);
    expect(openProperties).not.toHaveBeenCalled();
    expect(controller.isEnabled("layers.goTop")).toBe(false);
  });

  it("runs the layer shortcuts from the keyboard, Alt+PageUp included", () => {
    const { controller, doc } = state;
    doc.setActiveLayer(doc.layers[0] as Layer);
    const handled = controller.handleKeyDown(
      {
        code: "PageUp",
        altKey: true,
        ctrlKey: false,
        shiftKey: false,
        metaKey: false,
        preventDefault: () => {},
      },
      { editing: false },
    );
    expect(handled).toBe(true);
    expect(doc.activeLayer).toBe(doc.layers[1]);
    doc.dispose();
  });

  it("stops running commands once detached", () => {
    const controller = new ShortcutController(BUILT_IN_REGISTRY, "other");
    const doc = Document.createBlank({ width: 4, height: 4 });
    const release = registerLayerCommands(controller, {
      document: () => doc,
      openProperties: () => {},
      autoSelectNearest: () => false,
    });
    expect(controller.isEnabled("layers.add")).toBe(true);
    release();
    expect(controller.isEnabled("layers.add")).toBe(false);
    doc.dispose();
  });
});
