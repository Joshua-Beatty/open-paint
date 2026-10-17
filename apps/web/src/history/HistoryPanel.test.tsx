/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document } from "@openpaint/document";
import { iconShape } from "@openpaint/properties";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_REGISTRY, type BuiltInCommandId } from "../commands/catalog";
import { ShortcutController } from "../commands/shortcuts";
import { commonActionIcon } from "../shell/CommonActionsBar";
import { HistoryPanel } from "./HistoryPanel";
import { registerHistoryCommands } from "./history-commands";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

describe("HistoryPanel", () => {
  let doc: Document;
  let controller: ShortcutController<BuiltInCommandId>;

  /** The base item "New Image", then two "New Layer" steps. */
  function setup(): void {
    doc = Document.createBlank({ width: 4, height: 4 });
    doc.addLayer();
    doc.addLayer();
    controller = new ShortcutController(BUILT_IN_REGISTRY, "other");
    registerHistoryCommands(controller, () => doc);
  }

  function renderPanel(target: Document | undefined) {
    return render(<HistoryPanel doc={target} commands={controller} />);
  }

  function stepNames(): string[] {
    return screen
      .getAllByRole("listitem")
      .map((row) => row.querySelector(".app-history-name")?.textContent ?? "");
  }

  function rowAt(index: number): HTMLElement {
    const row = screen.getAllByRole("listitem")[index];
    if (row === undefined) throw new Error(`No step at ${index}`);
    return row;
  }

  function toolButton(name: string): HTMLButtonElement {
    return screen.getByRole("button", { name }) as HTMLButtonElement;
  }

  beforeEach(() => {
    setup();
  });

  afterEach(() => {
    cleanup();
    doc.dispose();
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  });

  it("lists the steps oldest first, starting with the origin step (UI-FTW-04)", () => {
    renderPanel(doc);
    expect(stepNames()).toEqual(["New Image", "New Layer", "New Layer"]);
    expect(rowAt(2).getAttribute("aria-current")).toBe("step");
    expect(rowAt(0).getAttribute("aria-current")).toBeNull();
    expect(rowAt(0).querySelector(".app-history-icon")?.getAttribute("data-kind")).toBe("document");
    expect(rowAt(1).querySelector(".app-history-icon")?.getAttribute("data-kind")).toBe("layer");
  });

  it("shows Undo and Redo as icon buttons with the common-actions toolbar's icons", () => {
    renderPanel(doc);
    for (const [name, id] of [
      ["Undo", "edit.undo"],
      ["Redo", "edit.redo"],
    ] as const) {
      const button = toolButton(name);
      expect(button.textContent).toBe("");
      expect(button.classList.contains("app-panel-tool")).toBe(true);
      const path = button.querySelector("svg.app-panel-tool-icon path")?.getAttribute("d");
      expect(path).toBe(iconShape(commonActionIcon(id) ?? "").path);
    }
  });

  /** Waits for the history work to finish, inside act so the panel's updates are flushed. */
  async function settle(assertion: () => void): Promise<void> {
    await act(async () => {
      await vi.waitFor(assertion);
    });
  }

  it("dims the redo steps after an undo (UI-FTW-04)", async () => {
    renderPanel(doc);
    expect(rowAt(2).classList.contains("is-undone")).toBe(false);
    await act(async () => {
      await doc.history.undo();
    });
    expect(rowAt(2).classList.contains("is-undone")).toBe(true);
    expect(rowAt(2).getAttribute("aria-current")).toBeNull();
    expect(rowAt(1).getAttribute("aria-current")).toBe("step");
  });

  it("jumps back to a step when it is clicked, and forward again to a redo step", async () => {
    renderPanel(doc);
    fireEvent.click(within(rowAt(0)).getByRole("button", { name: "New Image" }));
    await settle(() => expect(doc.layerCount).toBe(1));
    expect(rowAt(0).getAttribute("aria-current")).toBe("step");
    expect(rowAt(2).classList.contains("is-undone")).toBe(true);

    fireEvent.click(within(rowAt(2)).getByRole("button", { name: "New Layer" }));
    await settle(() => expect(doc.layerCount).toBe(3));
    expect(rowAt(2).classList.contains("is-undone")).toBe(false);
  });

  it("enables Undo and Redo by the history (UI-FTW-04)", async () => {
    renderPanel(doc);
    expect(toolButton("Undo").disabled).toBe(false);
    expect(toolButton("Redo").disabled).toBe(true);

    fireEvent.click(toolButton("Undo"));
    await settle(() => expect(doc.layerCount).toBe(2));
    expect(toolButton("Redo").disabled).toBe(false);
  });

  it("has only Undo and Redo in its toolbar; a step is clicked to jump further (UI-FTW-04)", () => {
    renderPanel(doc);
    const toolbar = screen.getByRole("toolbar", { name: "History tools" });
    expect(
      within(toolbar)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Undo", "Redo"]);
  });
  it("keeps the current step in view (UI-FTW-04)", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderPanel(doc);
    expect(scroll.mock.contexts).toContain(rowAt(2));
  });

  it("shows the empty state with no image, and disables every tool", () => {
    controller = new ShortcutController(BUILT_IN_REGISTRY, "other");
    renderPanel(undefined);
    expect(screen.getByText("No image is open.")).toBeTruthy();
    expect(toolButton("Undo").disabled).toBe(true);
    expect(toolButton("Redo").disabled).toBe(true);
  });
});
