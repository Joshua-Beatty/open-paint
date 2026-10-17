/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document, translationAffine } from "@openpaint/document";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { BUILT_IN_REGISTRY, type BuiltInCommandId } from "../commands/catalog";
import { platformFromName } from "../commands/keys";
import { ShortcutController } from "../commands/shortcuts";
import { StatusBar } from "./StatusBar";
import {
  registerUnitCommands,
  registerViewCommands,
  type UnitSettings,
  type ViewPort,
} from "./status-commands";
import { StatusStore } from "./status-store";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const fit = {
  mode: "fit" as const,
  zoom: 0.5,
  originX: 0,
  originY: 0,
  documentWidth: 300,
  documentHeight: 200,
};

function controller() {
  return new ShortcutController<BuiltInCommandId>(BUILT_IN_REGISTRY, platformFromName("Win32"));
}

describe("StatusBar", () => {
  let store: StatusStore;
  let commands: ShortcutController<BuiltInCommandId>;
  let engineView: Mock<ViewPort["view"]>;
  let settings: { set: Mock<UnitSettings["set"]> };
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
    store = new StatusStore();
    commands = controller();
    engineView = vi.fn<ViewPort["view"]>(async () => ({ mode: "fixed" as const, zoom: 1 }));
    settings = { set: vi.fn<UnitSettings["set"]>() };
    registerViewCommands(commands, { view: engineView }, true);
    registerUnitCommands(commands, settings);
    doc = Document.createBlank({ width: 300, height: 200 });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    doc.dispose();
  });

  function renderBar(
    options: {
      units?: "Pixel" | "Inch" | "Centimeter";
      onZoom?: (ratio: number) => void;
      shortcuts?: ShortcutController<BuiltInCommandId>;
    } = {},
  ) {
    return render(
      <StatusBar
        store={store}
        doc={doc}
        units={options.units ?? "Pixel"}
        commands={options.shortcuts ?? commands}
        onZoom={options.onZoom ?? (() => {})}
      />,
    );
  }

  it("shows the image size, the cursor's image pixel and the zoom (UI-SB-01)", () => {
    act(() => store.setLayout({ ...fit, mode: "fixed", zoom: 2 }));
    act(() => store.setPointer({ x: 10, y: 20 }));
    renderBar();
    expect(screen.getByText("300 × 200")).toBeDefined();
    expect(screen.getByText("5, 10")).toBeDefined();
    expect(screen.getByText("200%")).toBeDefined();
  });

  it("converts the image size and cursor into the chosen unit", () => {
    act(() => store.setLayout({ ...fit, mode: "fixed", zoom: 1 }));
    act(() => store.setPointer({ x: 96, y: 48 }));
    renderBar({ units: "Inch" });
    expect(screen.getByText("3.13 × 2.08")).toBeDefined();
    expect(screen.getByText("1, 0.5")).toBeDefined();
    expect(screen.getByRole("button", { name: "Units" }).textContent).toBe("in");
  });

  it("blanks the cursor outside the image", () => {
    act(() => store.setLayout({ ...fit, mode: "fixed", zoom: 1 }));
    act(() => store.setPointer({ x: 400, y: 20 }));
    renderBar();
    expect(screen.queryByText(/^\d+, \d+$/)).toBeNull();
  });

  it("puts the selection readout in a polite live region (UI-SB-02)", () => {
    doc.selectAll();
    renderBar();
    const readout = screen.getByText(/^Selection top left/);
    expect(readout.textContent).toBe(
      "Selection top left: 0px, 0px. Bounding rectangle size: 300px × 200px. Area: 60000 pixels square",
    );
    expect(readout.getAttribute("aria-live")).toBe("polite");
  });

  it("follows a live selection preview by itself, without its parent re-rendering", async () => {
    doc.selectAll();
    renderBar();
    act(() => doc.previewSelection(doc.selection.transform(translationAffine(10, 5)).commit()));
    // The accessible copy follows once the text is steady (PaintedText).
    await waitFor(() =>
      expect(screen.getByText(/^Selection top left/).textContent).toContain("10px, 5px"),
    );
  });

  it("shows a tool hint in place of the selection readout", () => {
    doc.selectAll();
    act(() =>
      store.setHint({ text: "Pan: When zoomed in close, click and drag to navigate the image" }),
    );
    renderBar();
    expect(screen.getByText(/^Pan: When zoomed in close/)).toBeDefined();
    expect(screen.queryByText(/^Selection top left/)).toBeNull();
  });

  it("shows a percentage progress bar, an indeterminate one, and hides it when idle (UI-SB-04)", () => {
    act(() => store.setProgress({ value: 40 }));
    renderBar();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40");
    expect(screen.getByText("40%")).toBeDefined();
    cleanup();

    act(() => store.setProgress({}));
    renderBar();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
    expect(screen.queryByText(/%$/)).toBeNull();
    cleanup();

    act(() => store.setProgress(undefined));
    renderBar();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("applies a typed zoom on Enter after removing % and spaces (UI-SB-03)", () => {
    const onZoom = vi.fn();
    act(() => store.setLayout({ ...fit, mode: "fixed", zoom: 2 }));
    renderBar({ onZoom });
    fireEvent.click(screen.getByText("200%"));
    const box = screen.getByRole("combobox", { name: "Zoom amount" }) as HTMLInputElement;
    expect(box.value).toBe("200");
    fireEvent.change(box, { target: { value: " 50 % " } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onZoom).toHaveBeenCalledWith(0.5);
    expect(screen.queryByRole("combobox", { name: "Zoom amount" })).toBeNull();
  });

  it("keeps the box open with an error cue for an invalid zoom (UI-SB-03)", () => {
    const onZoom = vi.fn();
    act(() => store.setLayout({ ...fit, mode: "fixed", zoom: 2 }));
    renderBar({ onZoom });
    fireEvent.click(screen.getByText("200%"));
    const box = screen.getByRole("combobox", { name: "Zoom amount" });
    fireEvent.change(box, { target: { value: "abc" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onZoom).not.toHaveBeenCalled();
    const invalid = screen.getByRole("combobox", { name: "Zoom amount" });
    expect(invalid.getAttribute("aria-invalid")).toBe("true");
    expect(invalid.className).toContain("app-zoom-entry-invalid");
  });

  it("closes the zoom box on Esc or when it loses focus, without applying", () => {
    const onZoom = vi.fn();
    act(() => store.setLayout({ ...fit, mode: "fixed", zoom: 2 }));
    renderBar({ onZoom });
    fireEvent.click(screen.getByText("200%"));
    const box = screen.getByRole("combobox", { name: "Zoom amount" });
    fireEvent.change(box, { target: { value: "10" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("combobox", { name: "Zoom amount" })).toBeNull();

    fireEvent.click(screen.getByText("200%"));
    fireEvent.blur(screen.getByRole("combobox", { name: "Zoom amount" }));
    expect(screen.queryByRole("combobox", { name: "Zoom amount" })).toBeNull();
    expect(onZoom).not.toHaveBeenCalled();
  });

  it("runs the zoom buttons and the zoom-to-window toggle through the engine's view", () => {
    act(() => store.setLayout(fit));
    renderBar();

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(engineView).toHaveBeenLastCalledWith({ type: "zoomIn" });
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(engineView).toHaveBeenLastCalledWith({ type: "zoomOut" });
    fireEvent.click(screen.getByRole("button", { name: "Actual Size" }));
    expect(engineView).toHaveBeenLastCalledWith({ type: "actualSize" });
  });

  it("switches the toggle back to fit when the view is at a fixed zoom", () => {
    act(() => store.setLayout({ ...fit, mode: "fixed", zoom: 1 }));
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Zoom to Window" }));
    expect(engineView).toHaveBeenLastCalledWith({ type: "fit" });
  });

  it("disables the zoom controls while no image is open", () => {
    act(() => store.setLayout(fit));
    const idle = controller();
    registerViewCommands(idle, { view: engineView }, false);
    renderBar({ shortcuts: idle });
    expect((screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByText("50%") as HTMLButtonElement).disabled).toBe(true);
  });

  it("sets the zoom from the slider's position (UI-SB-01 item 11)", () => {
    const onZoom = vi.fn();
    act(() => store.setLayout({ ...fit, mode: "fixed", zoom: 1 }));
    renderBar({ onZoom });
    const slider = screen.getByRole("slider");
    expect((slider as HTMLInputElement).value).toBe("500");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onZoom).toHaveBeenCalled();
    expect(onZoom.mock.calls[0]?.[0]).toBeGreaterThan(1);
  });

  it("chooses the display unit from the units menu (UI-VIEW-05)", () => {
    renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Units" }));
    fireEvent.click(screen.getByText("Inches"));
    expect(settings.set).toHaveBeenLastCalledWith("workspace.measurementUnit", "Inch");
  });
});
