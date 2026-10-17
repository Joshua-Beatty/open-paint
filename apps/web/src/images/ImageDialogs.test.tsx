/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document, MemoryAccountant, TILE_BYTES } from "@openpaint/document";
import { MemorySettingsBackend, SettingsStore } from "@openpaint/storage";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type ImageDialogKind, ImageDialogs } from "./ImageDialogs";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

describe("image dialogs (DOC-NEW-01, DOC-IMG-02, DOC-IMG-03)", () => {
  let settings: SettingsStore;
  let doc: Document | undefined;

  beforeEach(async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    settings = await SettingsStore.open({
      backend: new MemorySettingsBackend(),
      channel: null,
      mirror: null,
      lifecycle: null,
      flushDelayMs: 60_000,
    });
    doc = undefined;
  });

  afterEach(async () => {
    cleanup();
    doc?.dispose();
    await settings.dispose();
    vi.unstubAllGlobals();
  });

  function open(
    kind: ImageDialogKind,
    onCreate = vi.fn<(created: Document) => void>(),
    readClipboardSize?: () => Promise<{ width: number; height: number } | undefined>,
  ) {
    const onClose = vi.fn<() => void>();
    const view = render(
      <ImageDialogs
        kind={kind}
        doc={doc}
        settings={settings}
        onClose={onClose}
        onCreate={onCreate}
        readClipboardSize={readClipboardSize}
      />,
    );
    return { view, onClose, onCreate };
  }

  function field(name: string, index = 0): HTMLInputElement {
    return screen.getAllByRole("textbox", { name })[index] as HTMLInputElement;
  }

  function okButton(): HTMLButtonElement {
    return screen.getByRole("button", { name: "OK" }) as HTMLButtonElement;
  }

  it("stays closed with no dialog requested", () => {
    doc = Document.createBlank({ width: 4, height: 4 });
    render(
      <ImageDialogs
        kind={undefined}
        doc={doc}
        settings={settings}
        onClose={() => {}}
        onCreate={() => {}}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  describe("New", () => {
    /** Opens New with an empty clipboard and waits for it, as it opens once the read answers. */
    async function openNew(onCreate = vi.fn<(created: Document) => void>()) {
      const opened = open("new", onCreate, () => Promise.resolve(undefined));
      await screen.findByRole("dialog", { name: "New" });
      return opened;
    }

    it("starts at 800 x 600 at 96 px per inch and creates a document from the fields", async () => {
      const { onCreate, onClose } = await openNew();
      expect(field("Width").value).toBe("800");
      expect(field("Height").value).toBe("600");
      expect(field("Resolution").value).toBe("96");

      fireEvent.change(field("Width"), { target: { value: "300" } });
      fireEvent.blur(field("Width"));
      fireEvent.click(okButton());

      expect(onCreate).toHaveBeenCalledTimes(1);
      const created = onCreate.mock.calls[0]?.[0];
      expect(created?.width).toBe(300);
      expect(created?.height).toBe(600);
      expect(created?.resolution).toEqual({ unit: "inch", x: 96, y: 96 });
      expect(created?.layerCount).toBe(1);
      expect(created?.activeLayer?.name).toBe("Background");
      expect(onClose).toHaveBeenCalledTimes(1);
      doc = created;
    });

    it("starts from the clipboard size unless the user has already typed a size", async () => {
      open("new", undefined, () => Promise.resolve({ width: 320, height: 240 }));
      await waitFor(() => expect(field("Width").value).toBe("320"));
      expect(field("Height").value).toBe("240");
    });

    it("paints its first frame with the clipboard size, never the default", async () => {
      const widths: string[] = [];
      const observer = new MutationObserver(() => {
        const width = screen.queryAllByRole("textbox", { name: "Width" })[0];
        if (width instanceof HTMLInputElement && widths.length === 0) widths.push(width.value);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      open("new", undefined, () => Promise.resolve({ width: 320, height: 240 }));
      expect(screen.queryByRole("dialog")).toBeNull();
      await screen.findByRole("dialog", { name: "New" });
      observer.disconnect();
      expect(widths).toEqual(["320"]);
      expect(field("Height").value).toBe("240");
    });

    it("opens with the default size when the clipboard is slow, then takes its late size", async () => {
      let resolveClipboard: (size: { width: number; height: number }) => void = () => {};
      open(
        "new",
        undefined,
        () =>
          new Promise((resolve) => {
            resolveClipboard = resolve;
          }),
      );
      await screen.findByRole("dialog", { name: "New" }, { timeout: 2000 });
      expect(field("Width").value).toBe("800");
      resolveClipboard({ width: 320, height: 240 });
      await waitFor(() => expect(field("Width").value).toBe("320"));
    });

    it("opens with the default size when the clipboard cannot be read", async () => {
      open("new", undefined, () => Promise.reject(new Error("denied")));
      await screen.findByRole("dialog", { name: "New" });
      expect(field("Width").value).toBe("800");
    });

    it("keeps a typed size over a late clipboard size", async () => {
      let resolveClipboard: (size: { width: number; height: number }) => void = () => {};
      open(
        "new",
        undefined,
        () =>
          new Promise((resolve) => {
            resolveClipboard = resolve;
          }),
      );
      await screen.findByRole("dialog", { name: "New" }, { timeout: 2000 });
      fireEvent.change(field("Width"), { target: { value: "111" } });
      fireEvent.blur(field("Width"));
      resolveClipboard({ width: 320, height: 240 });
      await Promise.resolve();
      expect(field("Width").value).toBe("111");
      expect(field("Height").value).toBe("600");
    });

    it("keeps OK disabled until the size is within 1 to 262,144 pixels", async () => {
      await openNew();
      expect(okButton().disabled).toBe(false);
      fireEvent.change(field("Width"), { target: { value: "0" } });
      fireEvent.blur(field("Width"));
      expect(okButton().disabled).toBe(true);
      fireEvent.change(field("Width"), { target: { value: "262145" } });
      fireEvent.blur(field("Width"));
      expect(okButton().disabled).toBe(true);
    });

    it("remembers the aspect ratio and the print unit when OK is pressed", async () => {
      const { onCreate } = await openNew();
      fireEvent.click(screen.getByRole("checkbox", { name: "Maintain aspect ratio" }));
      fireEvent.click(okButton());
      doc = onCreate.mock.calls[0]?.[0];
      expect(settings.get("workspace.maintainAspectRatio.newImage")).toBe(true);
      expect(settings.get("workspace.lastNonPixelUnits")).toBe("Inch");
    });
  });

  describe("Resize", () => {
    it("resizes every layer to the typed size and keeps the aspect ratio by default", async () => {
      doc = Document.createBlank({ width: 4, height: 4 });
      open("resize");
      expect(screen.getByRole("dialog", { name: "Resize" })).toBeDefined();
      fireEvent.change(field("Width"), { target: { value: "8" } });
      fireEvent.blur(field("Width"));
      expect(field("Height").value).toBe("8");
      fireEvent.click(okButton());
      await waitFor(() => expect(doc?.width).toBe(8));
      expect(doc.height).toBe(8);
      expect(doc.history.entries.at(-1)?.name).toBe("Resize");
      expect(settings.get("workspace.lastResampling")).toBe("bicubic");
    });

    it("applies a percentage and shows the current and new sizes", async () => {
      doc = Document.createBlank({ width: 40, height: 20 });
      open("resize");
      fireEvent.click(screen.getByRole("radio", { name: "By percentage:" }));
      fireEvent.change(field("Percentage"), { target: { value: "50" } });
      fireEvent.blur(field("Percentage"));
      expect(field("Width").value).toBe("20");
      expect(screen.getByText(/40 × 20 pixels/)).toBeDefined();
      fireEvent.click(okButton());
      await waitFor(() => expect(doc?.width).toBe(20));
      expect(doc.height).toBe(10);
    });

    it("shows a cancellable progress dialog, and Cancel leaves the image unchanged", async () => {
      doc = Document.createBlank({ width: 4, height: 4 });
      const entries = doc.history.entries.length;
      const { view, onClose } = open("resize");
      fireEvent.change(field("Width"), { target: { value: "8" } });
      fireEvent.blur(field("Width"));
      fireEvent.click(okButton());
      expect(onClose).toHaveBeenCalledTimes(1);
      view.rerender(
        <ImageDialogs
          kind={undefined}
          doc={doc}
          settings={settings}
          onClose={onClose}
          onCreate={vi.fn()}
        />,
      );
      expect(screen.getByText("Resizing...")).toBeDefined();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByText("Resizing...")).toBeNull());
      expect(doc.width).toBe(4);
      expect(doc.history.entries.length).toBe(entries);
    });

    it("reports an out-of-memory resize and leaves the image unchanged", async () => {
      doc = Document.createBlank({
        width: 4,
        height: 4,
        accountant: new MemoryAccountant(TILE_BYTES),
      });
      open("resize");
      fireEvent.change(field("Width"), { target: { value: "300" } });
      fireEvent.blur(field("Width"));
      fireEvent.click(okButton());
      await waitFor(() =>
        expect(screen.getByText("Not enough memory to resize the image.")).toBeDefined(),
      );
      expect(doc.width).toBe(4);
      expect(doc.height).toBe(4);
    });

    it("changes nothing on Cancel", () => {
      doc = Document.createBlank({ width: 4, height: 4 });
      const { onClose } = open("resize");
      fireEvent.change(field("Width"), { target: { value: "8" } });
      fireEvent.blur(field("Width"));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(doc.width).toBe(4);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("Canvas Size", () => {
    it("places the existing pixels by the chosen anchor and remembers it", () => {
      doc = Document.createBlank({ width: 4, height: 4 });
      open("canvasSize");
      expect(screen.getByRole("dialog", { name: "Canvas Size" })).toBeDefined();
      fireEvent.click(screen.getByRole("radio", { name: "Bottom Right" }));
      fireEvent.change(field("Width"), { target: { value: "8" } });
      fireEvent.blur(field("Width"));
      fireEvent.click(okButton());

      expect(doc.width).toBe(8);
      expect(doc.height).toBe(4);
      expect(doc.history.entries.at(-1)?.name).toBe("Canvas Size");
      expect(settings.get("workspace.lastCanvasSizeAnchor")).toBe("BottomRight");
      const layer = doc.layers[0];
      expect(layer?.pixels.readRegion({ x: 0, y: 0, width: 1, height: 1 }).data[3]).toBe(0);
      expect(layer?.pixels.readRegion({ x: 4, y: 0, width: 1, height: 1 }).data[3]).toBe(255);
    });
  });
});
