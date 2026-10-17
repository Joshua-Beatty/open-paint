/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document } from "@openpaint/document";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_REGISTRY, type BuiltInCommandId } from "../commands/catalog";
import { ShortcutController } from "../commands/shortcuts";
import { historyRunning, registerHistoryCommands } from "./history-commands";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

describe("history commands", () => {
  let doc: Document | undefined;
  let controller: ShortcutController<BuiltInCommandId>;
  let detach: () => void;

  beforeEach(() => {
    doc = Document.createBlank({ width: 4, height: 4 });
    controller = new ShortcutController(BUILT_IN_REGISTRY, "other");
    detach = registerHistoryCommands(controller, () => doc);
  });

  afterEach(() => {
    detach();
    doc?.dispose();
    doc = undefined;
  });

  it("disables Undo and Redo with nothing to step over (DOC-HIS-01)", () => {
    expect(controller.isEnabled("edit.undo")).toBe(false);
    expect(controller.isEnabled("edit.redo")).toBe(false);
  });

  it("undoes and redoes the active image through the controller", async () => {
    const image = doc;
    if (image === undefined) throw new Error("no image");
    image.addLayer();
    expect(image.layerCount).toBe(2);
    expect(controller.isEnabled("edit.undo")).toBe(true);

    expect(controller.invoke("edit.undo")).toBe(true);
    await vi.waitFor(() => expect(image.layerCount).toBe(1));
    expect(controller.isEnabled("edit.undo")).toBe(false);
    expect(controller.isEnabled("edit.redo")).toBe(true);

    expect(controller.invoke("edit.redo")).toBe(true);
    await vi.waitFor(() => expect(image.layerCount).toBe(2));
    expect(controller.isEnabled("edit.redo")).toBe(false);
  });

  it("reports a running Undo until it lands, and runs quick presses one after another", async () => {
    const image = doc;
    if (image === undefined) throw new Error("no image");
    image.addLayer();
    image.addLayer();
    expect(historyRunning()).toBeUndefined();
    controller.invoke("edit.undo");
    controller.invoke("edit.undo");
    const running = historyRunning();
    expect(running).toBeDefined();
    await running;
    expect(image.layerCount).toBe(1);
    expect(historyRunning()).toBeUndefined();
  });

  it("is disabled when no image is open", () => {
    doc?.dispose();
    doc = undefined;
    expect(controller.isEnabled("edit.undo")).toBe(false);
    expect(controller.invoke("edit.undo")).toBe(false);
  });

  it("detaches both commands", () => {
    detach();
    expect(controller.isEnabled("edit.undo")).toBe(false);
    expect(controller.isEnabled("edit.redo")).toBe(false);
    detach = () => {};
  });
});
