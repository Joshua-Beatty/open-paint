import { describe, expect, it, vi } from "vitest";
import { BUILT_IN_REGISTRY, type BuiltInCommandId } from "../commands/catalog";
import { ShortcutController } from "../commands/shortcuts";
import { registerImageDialogCommands } from "./image-commands";

describe("image dialog commands", () => {
  it("opens New at any time and Resize and Canvas Size only with an image", () => {
    const controller = new ShortcutController<BuiltInCommandId>(BUILT_IN_REGISTRY, "other");
    let hasImage = false;
    const open = vi.fn();
    registerImageDialogCommands(controller, { hasDocument: () => hasImage, open });

    expect(controller.isEnabled("file.new")).toBe(true);
    expect(controller.invoke("file.new")).toBe(true);
    expect(open).toHaveBeenLastCalledWith("new");

    expect(controller.isEnabled("image.resize")).toBe(false);
    expect(controller.invoke("image.resize")).toBe(false);
    expect(controller.isEnabled("image.canvasSize")).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);

    hasImage = true;
    expect(controller.invoke("image.resize")).toBe(true);
    expect(open).toHaveBeenLastCalledWith("resize");
    expect(controller.invoke("image.canvasSize")).toBe(true);
    expect(open).toHaveBeenLastCalledWith("canvasSize");
  });

  it("detaches every command when released", () => {
    const controller = new ShortcutController<BuiltInCommandId>(BUILT_IN_REGISTRY, "other");
    const open = vi.fn();
    const release = registerImageDialogCommands(controller, { hasDocument: () => true, open });
    release();
    expect(controller.invoke("file.new")).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
