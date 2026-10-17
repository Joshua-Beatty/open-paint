import { describe, expect, it, vi } from "vitest";
import { BUILT_IN_REGISTRY, type BuiltInCommandId } from "../commands/catalog";
import { ShortcutController } from "../commands/shortcuts";
import { type FileCommandOptions, registerFileCommands } from "./file-commands";
import type { FileFlows } from "./file-flows";

/** The flows the commands call. The commands only call these methods, so a fake is enough. */
function fakeFlows() {
  return {
    run: vi.fn((task: () => Promise<unknown>) => {
      void task();
    }),
    openFiles: vi.fn(async () => undefined),
    importFromFile: vi.fn(async () => undefined),
    saveActive: vi.fn(async () => undefined),
    saveAll: vi.fn(async () => undefined),
    printActive: vi.fn(async () => undefined),
    clearRecent: vi.fn(),
  };
}

function setup(overrides: Partial<Omit<FileCommandOptions, "flows">> = {}) {
  const controller = new ShortcutController<BuiltInCommandId>(BUILT_IN_REGISTRY, "other");
  const flows = fakeFlows();
  const options = {
    flows: flows as unknown as FileFlows,
    hasImage: () => false,
    hasUnsaved: () => false,
    hasRecent: () => false,
    ...overrides,
  };
  const release = registerFileCommands(controller, options);
  return { controller, flows, release };
}

describe("file commands (FMT-OPEN-01, FMT-SAVE-01)", () => {
  it("opens files at any time", () => {
    const { controller, flows } = setup();
    expect(controller.isEnabled("file.open")).toBe(true);
    expect(controller.invoke("file.open")).toBe(true);
    expect(flows.openFiles).toHaveBeenCalledTimes(1);
  });

  it("enables Save and Save As only with an image open", () => {
    let hasImage = false;
    const { controller, flows } = setup({ hasImage: () => hasImage });

    expect(controller.invoke("file.save")).toBe(false);
    expect(controller.invoke("file.saveAs")).toBe(false);
    expect(flows.saveActive).not.toHaveBeenCalled();

    hasImage = true;
    expect(controller.invoke("file.save")).toBe(true);
    expect(flows.saveActive).toHaveBeenLastCalledWith(false);
    expect(controller.invoke("file.saveAs")).toBe(true);
    expect(flows.saveActive).toHaveBeenLastCalledWith(true);
  });

  it("enables Save All only when an image has unsaved changes", () => {
    let unsaved = false;
    const { controller, flows } = setup({ hasUnsaved: () => unsaved });

    expect(controller.isEnabled("file.saveAll")).toBe(false);
    expect(controller.invoke("file.saveAll")).toBe(false);

    unsaved = true;
    expect(controller.isEnabled("file.saveAll")).toBe(true);
    expect(controller.invoke("file.saveAll")).toBe(true);
    expect(flows.saveAll).toHaveBeenCalledTimes(1);
  });

  it("prints only with an image open (FMT-PRN-01)", () => {
    let hasImage = false;
    const { controller, flows } = setup({ hasImage: () => hasImage });

    expect(controller.isEnabled("file.print")).toBe(false);
    expect(controller.invoke("file.print")).toBe(false);

    hasImage = true;
    expect(controller.invoke("file.print")).toBe(true);
    expect(flows.printActive).toHaveBeenCalledTimes(1);
  });

  it("enables Clear this list only when Open Recent has entries", () => {
    let entries = false;
    const { controller, flows } = setup({ hasRecent: () => entries });

    expect(controller.invoke("file.clearRecent")).toBe(false);
    entries = true;
    expect(controller.invoke("file.clearRecent")).toBe(true);
    expect(flows.clearRecent).toHaveBeenCalledTimes(1);
  });

  it("imports files into the active image only when an image is open (DOC-LYR-05e)", () => {
    let hasImage = false;
    const { controller, flows } = setup({ hasImage: () => hasImage });

    expect(controller.isEnabled("layers.importFromFile")).toBe(false);
    expect(controller.invoke("layers.importFromFile")).toBe(false);

    hasImage = true;
    expect(controller.invoke("layers.importFromFile")).toBe(true);
    expect(flows.importFromFile).toHaveBeenCalledTimes(1);
  });

  it("detaches every command when released", () => {
    const { controller, release } = setup();
    release();
    expect(controller.invoke("file.open")).toBe(false);
    expect(controller.invoke("file.clearRecent")).toBe(false);
  });
});
