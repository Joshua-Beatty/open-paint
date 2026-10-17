/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document, type Layer } from "@openpaint/document";
import { iconShape } from "@openpaint/properties";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { BUILT_IN_REGISTRY, type BuiltInCommandId } from "../commands/catalog";
import { ShortcutController } from "../commands/shortcuts";
import { PHOSPHOR } from "../icons/icon-set";
import { LayersPanel } from "./LayersPanel";
import { registerLayerCommands } from "./layer-commands";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/**
 * Dispatches a pointer event with a vertical position. jsdom has no PointerEvent, so a MouseEvent
 * of the same type carries the position, which React and the window listeners read the same way.
 */
function pointer(target: EventTarget, type: string, clientY: number): void {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientY, button: 0 }));
  });
}

describe("LayersPanel", () => {
  let doc: Document;
  let controller: ShortcutController<BuiltInCommandId>;
  let openProperties: Mock<() => void>;

  /** Three layers: "Background" at the bottom, then "Layer 2" and "Layer 3". */
  function setup(): void {
    doc = Document.createBlank({ width: 4, height: 4 });
    doc.addLayer();
    doc.addLayer();
    controller = new ShortcutController(BUILT_IN_REGISTRY, "other");
    openProperties = vi.fn<() => void>();
    registerLayerCommands(controller, {
      document: () => doc,
      openProperties,
      autoSelectNearest: () => false,
    });
  }

  function renderPanel(target: Document | undefined = doc) {
    return render(
      <LayersPanel doc={target} commands={controller} autoSelectNearest={() => false} />,
    );
  }

  function rowNames(): string[] {
    return screen
      .getAllByRole("listitem")
      .map((row) => row.querySelector(".app-layer-name")?.textContent ?? "");
  }

  function rowFor(name: string): HTMLElement {
    const row = screen
      .getAllByRole("listitem")
      .find((item) => item.querySelector(".app-layer-name")?.textContent === name);
    if (row === undefined) throw new Error(`No row named ${name}`);
    return row;
  }

  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    setup();
  });

  afterEach(() => {
    cleanup();
    doc.dispose();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("lists the layers top first and marks the active one (UI-FTW-05)", () => {
    renderPanel();
    expect(rowNames()).toEqual(["Layer 3", "Layer 2", "Background"]);
    expect(rowFor("Layer 3").getAttribute("aria-current")).toBe("true");
    expect(rowFor("Background").getAttribute("aria-current")).toBeNull();
  });

  it("sizes each thumbnail box to the image's aspect ratio, so no checkerboard band shows", () => {
    const wide = Document.createBlank({ width: 800, height: 400 });
    renderPanel(wide);
    const box = screen
      .getAllByRole("listitem")[0]
      ?.querySelector<HTMLElement>(".app-layer-thumb-image");
    expect(box?.style.width).toBe("40px");
    expect(box?.style.height).toBe("20px");
    cleanup();
    wide.dispose();
  });

  it("makes a layer active when its row is clicked", () => {
    renderPanel();
    fireEvent.click(within(rowFor("Background")).getByRole("button", { name: "Background" }));
    expect(doc.activeLayer?.name).toBe("Background");
    expect(rowFor("Background").getAttribute("aria-current")).toBe("true");
  });

  it("toggles visibility from the checkbox and activates that layer", () => {
    renderPanel();
    const checkbox = within(rowFor("Layer 2")).getByRole("checkbox", { name: "Visible: Layer 2" });
    fireEvent.click(checkbox);
    const layer = doc.layers[1] as Layer;
    expect(layer.visible).toBe(false);
    expect(doc.activeLayer).toBe(layer);
    expect(rowFor("Layer 2").getAttribute("aria-current")).toBe("true");
  });

  it("opens Layer Properties on double-click, but not on the checkbox", () => {
    renderPanel();
    fireEvent.doubleClick(rowFor("Layer 2"));
    expect(openProperties).toHaveBeenCalledTimes(1);
    expect(doc.activeLayer?.name).toBe("Layer 2");
    fireEvent.doubleClick(
      within(rowFor("Layer 3")).getByRole("checkbox", { name: "Visible: Layer 3" }),
    );
    expect(openProperties).toHaveBeenCalledTimes(1);
  });

  it("runs the toolbar buttons through the layer commands", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Add New Layer" }));
    expect(doc.layerCount).toBe(4);
    expect(doc.activeLayer).toBe(doc.layers[3]);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Layer" }));
    expect(doc.layerCount).toBe(5);
    fireEvent.click(screen.getByRole("button", { name: "Layer Properties" }));
    expect(openProperties).toHaveBeenCalledTimes(1);
  });

  it("shows the toolbar as named icon buttons in UI-FTW-05 order", () => {
    renderPanel();
    const toolbar = screen.getByRole("toolbar", { name: "Layer tools" });
    const buttons = within(toolbar).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Add New Layer",
      "Delete Layer",
      "Duplicate Layer",
      "Merge Layer Down",
      "Move Layer Up",
      "Move Layer Down",
      "Layer Properties",
    ]);
    const icons = [
      PHOSPHOR.plus,
      PHOSPHOR.trash,
      PHOSPHOR.copy,
      PHOSPHOR.arrowsMerge,
      PHOSPHOR.arrowUp,
      PHOSPHOR.arrowDown,
      PHOSPHOR.slidersHorizontal,
    ];
    buttons.forEach((button, index) => {
      expect(button.textContent).toBe("");
      const path = button.querySelector("svg.app-panel-tool-icon path")?.getAttribute("d");
      expect(path).toBe(iconShape(icons[index] ?? "").path);
    });
  });

  it("disables the buttons whose enable rules do not hold", () => {
    doc.setActiveLayer(doc.layers[0] as Layer);
    renderPanel();
    expect(screen.getByRole("button", { name: "Merge Layer Down" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "Move Layer Down" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "Move Layer Up" }).hasAttribute("disabled")).toBe(
      false,
    );
    act(() => {
      doc.setActiveLayer(doc.layers[2] as Layer);
    });
    expect(screen.getByRole("button", { name: "Move Layer Up" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "Move Layer Down" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("moves the layer to the top with Ctrl+click on Move Layer Up (UI-FTW-05)", () => {
    doc.setActiveLayer(doc.layers[0] as Layer);
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Move Layer Up" }), { ctrlKey: true });
    expect(rowNames()).toEqual(["Background", "Layer 3", "Layer 2"]);
    expect(doc.history.undoName).toBe("Move Layer to Top");
  });

  it("reorders a layer by dragging its row, as one Move Layer item", () => {
    renderPanel();
    const bottom = rowFor("Background");
    pointer(bottom, "pointerdown", 200);
    pointer(window, "pointermove", 120);
    pointer(window, "pointerup", 120);
    expect(doc.layers.map((layer) => layer.name)).toEqual(["Layer 2", "Layer 3", "Background"]);
    expect(doc.history.undoName).toBe("Move Layer");
    expect(doc.activeLayer?.name).toBe("Background");
  });

  it("does not move a layer for a press shorter than the drag threshold", () => {
    renderPanel();
    const before = doc.history.entries.length;
    pointer(rowFor("Layer 2"), "pointerdown", 200);
    pointer(window, "pointermove", 202);
    pointer(window, "pointerup", 202);
    expect(doc.layers.map((layer) => layer.name)).toEqual(["Background", "Layer 2", "Layer 3"]);
    expect(doc.history.entries.length).toBe(before);
  });

  it("shows the empty state and disables the toolbar with no image open", () => {
    const empty = new ShortcutController(BUILT_IN_REGISTRY, "other");
    registerLayerCommands(empty, {
      document: () => undefined,
      openProperties,
      autoSelectNearest: () => false,
    });
    render(<LayersPanel doc={undefined} commands={empty} autoSelectNearest={() => false} />);
    expect(screen.getByText("No image is open.")).toBeDefined();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Add New Layer" }).hasAttribute("disabled")).toBe(
      true,
    );
  });
});
