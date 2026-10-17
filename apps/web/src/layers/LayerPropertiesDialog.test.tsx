/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document } from "@openpaint/document";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LayerPropertiesDialog } from "./LayerPropertiesDialog";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

describe("LayerPropertiesDialog", () => {
  let doc: Document;

  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    doc = Document.createBlank({ width: 4, height: 4 });
    doc.addLayer();
    doc.setActiveLayerProperties({ name: "Sketch", opacity: 200 });
  });

  afterEach(() => {
    cleanup();
    doc.dispose();
    vi.unstubAllGlobals();
  });

  it("shows the active layer's name, visibility, blend mode and opacity", () => {
    render(<LayerPropertiesDialog doc={doc} isOpen onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Layer Properties" })).toBeDefined();
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe(
      "Sketch",
    );
    expect(screen.getByRole("checkbox", { name: "Visible" })).toBeDefined();
    expect(screen.getByRole("button", { name: /Normal/ })).toBeDefined();
    expect((screen.getByRole("textbox", { name: "Opacity value" }) as HTMLInputElement).value).toBe(
      "200",
    );
  });

  it("records one history item and marks the document dirty on OK", () => {
    const onClose = vi.fn();
    render(<LayerPropertiesDialog doc={doc} isOpen onClose={onClose} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Ink" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Visible" }));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(doc.activeLayer?.name).toBe("Ink");
    expect(doc.activeLayer?.visible).toBe(false);
    expect(doc.dirty).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("changes nothing on Cancel", () => {
    const onClose = vi.fn();
    render(<LayerPropertiesDialog doc={doc} isOpen onClose={onClose} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Ink" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(doc.activeLayer?.name).toBe("Sketch");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Esc through its onClose", () => {
    const onClose = vi.fn();
    render(<LayerPropertiesDialog doc={doc} isOpen onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("previews changes on the layer without a history item, then records one on OK", () => {
    const onClose = vi.fn();
    const steps = doc.history.entries.length;
    render(<LayerPropertiesDialog doc={doc} isOpen onClose={onClose} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Opacity value" }), {
      target: { value: "40" },
    });
    fireEvent.blur(screen.getByRole("textbox", { name: "Opacity value" }));
    expect(doc.activeLayer?.opacity).toBe(40);
    expect(doc.history.entries.length).toBe(steps);
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(doc.activeLayer?.opacity).toBe(40);
    expect(doc.history.entries.length).toBe(steps + 1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores the values the layer had when it opened on Cancel and on Esc", () => {
    const onClose = vi.fn();
    const { unmount } = render(<LayerPropertiesDialog doc={doc} isOpen onClose={onClose} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Ink" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Visible" }));
    expect(doc.activeLayer?.name).toBe("Ink");
    expect(doc.activeLayer?.visible).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(doc.activeLayer?.name).toBe("Sketch");
    expect(doc.activeLayer?.visible).toBe(true);
    expect(doc.dirty).toBe(true);
    unmount();

    render(<LayerPropertiesDialog doc={doc} isOpen onClose={onClose} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Opacity value" }), {
      target: { value: "10" },
    });
    fireEvent.blur(screen.getByRole("textbox", { name: "Opacity value" }));
    expect(doc.activeLayer?.opacity).toBe(10);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
    expect(doc.activeLayer?.opacity).toBe(200);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("truncates a name longer than 256 characters on OK", () => {
    render(<LayerPropertiesDialog doc={doc} isOpen onClose={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "n".repeat(300) },
    });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(doc.activeLayer?.name).toHaveLength(256);
  });

  it("stays closed while not open, and with no image", () => {
    const { rerender } = render(
      <LayerPropertiesDialog doc={doc} isOpen={false} onClose={() => {}} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<LayerPropertiesDialog doc={undefined} isOpen onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
