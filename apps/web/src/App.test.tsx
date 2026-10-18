/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import type { EngineError, EngineHandle, EngineStatus, ViewLayout } from "@openpaint/engine";
import { MemorySettingsBackend, SettingsStore } from "@openpaint/storage";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { UpdateController } from "./help/updates";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const engine = vi.hoisted(() => ({ startEngine: vi.fn() }));
vi.mock("@openpaint/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openpaint/engine")>()),
  ...engine,
}));

const openSettingsStore = SettingsStore.open.bind(SettingsStore);

/** Opens in-memory settings. The first launch is done unless `firstLaunch` is true (SET-LIFE-10). */
async function openMemorySettings(firstLaunch: boolean): Promise<SettingsStore> {
  const store = await openSettingsStore({ backend: new MemorySettingsBackend() });
  if (!firstLaunch) store.set("app.firstRunCompleted", true);
  return store;
}

/**
 * Waits for the blank image the app opens at start, then closes it (Ctrl+W), for the checks of the
 * app with no image open. The image is untouched, so it closes without a prompt.
 */
async function closeStartImage(): Promise<void> {
  await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
  fireEvent.keyDown(document.body, { code: "KeyW", ctrlKey: true });
  await waitFor(() => expect(screen.queryAllByRole("tab")).toHaveLength(0));
}

const gpuStatus: EngineStatus = {
  setting: "Automatic",
  backend: "webgpu",
  reason: "chosen",
  webgpuAvailable: true,
  performanceClass: "Good",
  errorFlags: 0,
  performanceCache: {},
  deviceLossCount: 0,
};

describe("App", () => {
  let emit: (status: EngineStatus) => void = () => {};
  let emitLayout: (layout: ViewLayout) => void = () => {};
  let emitError: (error: EngineError) => void = () => {};
  const handle = {
    status: gpuStatus,
    onStatus: (listener: (status: EngineStatus) => void) => {
      emit = listener;
      return () => {};
    },
    onError: (listener: (error: EngineError) => void) => {
      emitError = listener;
      return () => {};
    },
    onLayout: (listener: (layout: ViewLayout) => void) => {
      emitLayout = listener;
      return () => {};
    },
    setBackend: vi.fn(),
    resize: vi.fn(),
    loadTestDocument: vi.fn(),
    syncDocument: vi.fn(),
    // Like the real engine, view commands answer with the view they leave.
    view: vi.fn(async () => ({ mode: "fit" as const, zoom: 1 })),
    wheel: vi.fn(async () => ({ mode: "fit" as const, zoom: 1 })),
    setCanvasStyle: vi.fn(),
    setVisible: vi.fn(),
    perf: vi.fn(),
    onPerf: vi.fn(),
    terminate: vi.fn(),
    version: "v1",
    onResync: () => () => {},
    strokeBegin: vi.fn(),
    strokeSamples: vi.fn(),
    strokeEnd: vi.fn(),
    strokeCancel: vi.fn(),
    effectRun: vi.fn(),
    effectCancel: vi.fn(),
    effectRelease: vi.fn(),
    effectConfirm: vi.fn(async () => true),
  } satisfies EngineHandle;

  beforeEach(() => {
    vi.spyOn(SettingsStore, "open").mockImplementation(() => openMemorySettings(false));
    engine.startEngine.mockResolvedValue(handle);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("renders the OpenPaint shell and hands a canvas to the engine", async () => {
    const { container, unmount } = render(<App />);
    expect(screen.getByRole("heading", { name: "OpenPaint" })).toBeDefined();
    const canvas = container.querySelector("canvas:not(.app-canvas-overlay)");
    expect(engine.startEngine).toHaveBeenCalledWith(
      canvas,
      expect.any(Object),
      undefined,
      expect.objectContaining({ onWorkerError: expect.any(Function) }),
    );
    expect(await screen.findByText("", { selector: "[data-backend=webgpu]" })).toBeDefined();
    unmount();
    expect(handle.terminate).toHaveBeenCalled();
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("shows a notice when repeated device loss forces the CPU backend", async () => {
    render(<App />);
    await screen.findByText("", { selector: "[data-backend=webgpu]" });
    act(() => emit({ ...gpuStatus, backend: "cpu", reason: "device-loss", errorFlags: 1 }));
    expect(screen.getByRole("status").textContent).toBe(
      "GPU acceleration was turned off automatically after repeated GPU errors.",
    );
  });

  it("logs an error the engine worker reports and says so once", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<App />);
    await screen.findByText("", { selector: "[data-backend=webgpu]" });
    act(() => emitError({ name: "Error", message: "Uncaptured GPU error: bad bind group" }));
    act(() => emitError({ name: "Error", message: "another" }));
    expect(screen.getByRole("status").textContent).toContain(
      "The canvas renderer reported an error.",
    );
    expect(consoleError).toHaveBeenCalledWith(
      "Engine worker:",
      "Uncaptured GPU error: bad bind group",
    );
    fireEvent.click(within(screen.getByRole("status")).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("restarts on engine v1 with the CPU fallback when engine v2 gives up its GPU", async () => {
    const { container } = render(<App />);
    await screen.findByText("", { selector: "[data-backend=webgpu]" });
    const cpu: EngineStatus = {
      ...gpuStatus,
      backend: "cpu",
      reason: "device-loss",
      errorFlags: 1,
    };
    engine.startEngine.mockResolvedValue({ ...handle, status: cpu });
    act(() => emit({ ...cpu, engine: "v2" }));
    await waitFor(() => expect(engine.startEngine).toHaveBeenCalledTimes(2));
    expect(handle.terminate).toHaveBeenCalled();
    const canvas = container.querySelector("canvas:not(.app-canvas-overlay)");
    expect(engine.startEngine).toHaveBeenLastCalledWith(
      canvas,
      expect.any(Object),
      expect.objectContaining({ errorFlags: 1 }),
      expect.not.objectContaining({ engine: "v2" }),
    );
    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      "GPU acceleration was turned off automatically after repeated GPU errors.",
    );
  });

  it("offers a reload when no engine can start", async () => {
    engine.startEngine.mockRejectedValue(new Error("The canvas cannot present bitmaps."));
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The canvas could not be started");
    expect(within(alert).getByRole("button", { name: "Reload" })).toBeDefined();
  });

  it("opens a blank Untitled image on a later start with no session to restore (owner request)", async () => {
    render(<App />);
    await waitFor(() => expect(document.title).toBe("Untitled - OpenPaint"));
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("shows the engine's zoom in the status bar, disabled while no image is open", async () => {
    render(<App />);
    await closeStartImage();
    await screen.findByText("", { selector: "[data-backend=webgpu]" });
    act(() =>
      emitLayout({
        mode: "fixed",
        zoom: 0.5,
        originX: 0,
        originY: 0,
        documentWidth: 300,
        documentHeight: 200,
      }),
    );
    expect(screen.getByText("50%").closest("button")?.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Zoom to Window" })).toBeDefined();
  });

  it("titles the window with the app name when no image is open", async () => {
    render(<App />);
    await closeStartImage();
    expect(document.title).toBe("OpenPaint");
  });

  it("applies the stored Color Scheme from the localStorage mirror", () => {
    localStorage.setItem("openpaint.setting.ui.theme", "Dark");
    try {
      render(<App />);
      expect(document.documentElement.dataset.colorScheme).toBe("dark");
    } finally {
      localStorage.removeItem("openpaint.setting.ui.theme");
      delete document.documentElement.dataset.colorScheme;
    }
  });

  it("keeps the canvas inside the shell's canvas area, not over the sidebars", () => {
    const { container } = render(<App />);
    const canvasArea = container.querySelector(".app-canvas-area");
    expect(canvasArea?.querySelector(".app-viewport")).not.toBeNull();
    expect(canvasArea?.querySelector(".app-sidebar")).toBeNull();
  });

  it("opens the Help menu with Alt+H and the shortcut reference from its item", async () => {
    render(<App />);
    fireEvent.keyDown(document.body, { code: "KeyH", altKey: true });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Keyboard Shortcuts" }));
    expect(await screen.findByRole("dialog", { name: "Keyboard Shortcuts" })).toBeDefined();
  });

  it("toggles the Tools sidebar with F5 or Alt+F5 and returns focus to the canvas (UI-AUX-02)", async () => {
    const { container } = render(<App />);
    expect(await screen.findByRole("region", { name: "Tools" })).toBeDefined();
    fireEvent.keyDown(document.body, { code: "F5" });
    expect(screen.queryByRole("region", { name: "Tools" })).toBeNull();
    expect(document.activeElement).toBe(container.querySelector(".app-canvas-area"));
    fireEvent.keyDown(document.body, { code: "F5", altKey: true });
    expect(await screen.findByRole("region", { name: "Tools" })).toBeDefined();
  });

  it("hides the right sidebar when every panel in it is hidden (UI-FTW-07)", async () => {
    const { container } = render(<App />);
    await screen.findByRole("region", { name: "History" });
    expect(container.querySelector(".app-sidebar-right")).not.toBeNull();
    fireEvent.keyDown(document.body, { code: "F6" });
    fireEvent.keyDown(document.body, { code: "F7" });
    fireEvent.keyDown(document.body, { code: "F8" });
    expect(container.querySelector(".app-sidebar-right")).toBeNull();
    expect(
      container.querySelector(".app-canvas-area")?.querySelector(".app-viewport"),
    ).not.toBeNull();
  });

  it("keeps each aux toggle checked to match its panel's visibility", async () => {
    render(<App />);
    await screen.findByRole("region", { name: "History" });
    const history = screen.getByRole("button", { name: "History" });
    expect(history.getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(document.body, { code: "F6" });
    expect(history.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("region", { name: "History" })).toBeNull();
  });

  it("shows the Layers panel's empty state while no image is open (UI-FTW-05)", async () => {
    render(<App />);
    await closeStartImage();
    const layers = await screen.findByRole("region", { name: "Layers" });
    expect(within(layers).getByText("No image is open.")).toBeDefined();
  });

  it("shows the History panel's empty state with the undo tools disabled (UI-FTW-04)", async () => {
    render(<App />);
    await closeStartImage();
    const history = await screen.findByRole("region", { name: "History" });
    expect(within(history).getByText("No image is open.")).toBeDefined();
    expect(within(history).getByRole("button", { name: "Undo" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("intercepts a bound shortcut so the browser's default does not run (WEB-KEY-07)", () => {
    render(<App />);
    expect(fireEvent.keyDown(document.body, { code: "KeyS", ctrlKey: true })).toBe(false);
    expect(fireEvent.keyDown(document.body, { code: "KeyQ", ctrlKey: true })).toBe(true);
  });

  it("opens a blank Untitled image on first launch (SET-LIFE-10)", async () => {
    vi.mocked(SettingsStore.open).mockImplementation(() => openMemorySettings(true));
    render(<App />);
    await waitFor(() => expect(document.title).toBe("Untitled - OpenPaint"));
  });

  it("shows the loading notice only once start-up takes longer than 300 ms (SET-LIFE-03)", async () => {
    vi.mocked(SettingsStore.open).mockImplementation(() => new Promise<SettingsStore>(() => {}));
    render(<App />);
    expect(screen.queryByText("Loading OpenPaint...")).toBeNull();
    expect(
      await screen.findByText("Loading OpenPaint...", undefined, { timeout: 1000 }),
    ).toBeDefined();
  });

  it("offers only Keyboard Shortcuts and About in the Help menu, and F1 does nothing (owner request)", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue({ opener: {} } as unknown as Window);
    render(<App />);
    fireEvent.keyDown(document.body, { code: "F1" });
    expect(open).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { code: "KeyH", altKey: true });
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      expect.stringMatching(/^Keyboard Shortcuts/),
      expect.stringMatching(/^About/),
    ]);
  });

  it("records the running version after an update without showing a panel (SET-LIFE-10)", async () => {
    const store = await openMemorySettings(false);
    store.set("app.lastRunVersion", "0.0.0-previous");
    vi.mocked(SettingsStore.open).mockResolvedValue(store);
    render(<App />);
    await screen.findByRole("region", { name: "Tools" });
    await waitFor(() => expect(store.get("app.lastRunVersion")).toBe(__APP_VERSION__));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks about unsaved images before an update reloads, and reloads only after the prompt (SET-UPD-01)", async () => {
    vi.mocked(SettingsStore.open).mockImplementation(() => openMemorySettings(true));
    const host = { check: vi.fn(() => Promise.resolve(true)), activate: vi.fn<() => void>() };
    const updates = new UpdateController(host, { isOnline: () => true });
    render(<App updates={updates} />);
    await waitFor(() => expect(document.title).toBe("Untitled - OpenPaint"));
    act(() => updates.markWaiting());
    fireEvent.keyDown(document.body, { code: "KeyN", ctrlKey: true, shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Reload now" }));
    expect(await screen.findByRole("dialog", { name: "Unsaved Changes" })).toBeDefined();
    expect(host.activate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(host.activate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload now" }));
    fireEvent.click(await screen.findByRole("button", { name: "Don't Save" }));
    expect(host.activate).toHaveBeenCalledTimes(1);
  });

  it("reloads straight away when no image has unsaved changes (SET-UPD-04)", async () => {
    vi.mocked(SettingsStore.open).mockImplementation(() => openMemorySettings(true));
    const host = { check: vi.fn(() => Promise.resolve(true)), activate: vi.fn<() => void>() };
    const updates = new UpdateController(host, { isOnline: () => true });
    render(<App updates={updates} />);
    await waitFor(() => expect(document.title).toBe("Untitled - OpenPaint"));
    act(() => updates.markWaiting());
    fireEvent.click(screen.getByRole("button", { name: "Reload now" }));
    expect(host.activate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Unsaved Changes" })).toBeNull();
  });

  it("does not count a selection on the blank start image as unsaved work (owner request)", async () => {
    vi.mocked(SettingsStore.open).mockImplementation(() => openMemorySettings(true));
    const host = { check: vi.fn(() => Promise.resolve(true)), activate: vi.fn<() => void>() };
    const updates = new UpdateController(host, { isOnline: () => true });
    render(<App updates={updates} />);
    await waitFor(() => expect(document.title).toBe("Untitled - OpenPaint"));
    fireEvent.keyDown(document.body, { code: "KeyA", ctrlKey: true });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Deselect" }).hasAttribute("disabled")).toBe(false),
    );
    // No asterisk in the title, and no unsaved dot on the tab.
    expect(document.title).toBe("Untitled - OpenPaint");
    expect(document.querySelector(".app-image-tab-dirty")).toBeNull();
    // The leave-page prompt does not ask.
    const leave = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(false);
    // An update reloads without the Unsaved Changes prompt.
    act(() => updates.markWaiting());
    fireEvent.click(screen.getByRole("button", { name: "Reload now" }));
    expect(screen.queryByRole("dialog", { name: "Unsaved Changes" })).toBeNull();
    expect(host.activate).toHaveBeenCalledTimes(1);
    // Close does not ask either.
    fireEvent.keyDown(document.body, { code: "KeyW", ctrlKey: true });
    expect(screen.queryByRole("dialog", { name: "Unsaved Changes" })).toBeNull();
    expect(document.title).toBe("OpenPaint");
  });

  it("asks before leaving once the start image has a real edit (WEB-UI-06)", async () => {
    vi.mocked(SettingsStore.open).mockImplementation(() => openMemorySettings(true));
    render(<App />);
    await waitFor(() => expect(document.title).toBe("Untitled - OpenPaint"));
    fireEvent.keyDown(document.body, { code: "KeyN", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(document.title).toBe("*Untitled - OpenPaint"));
    const leave = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(true);
  });

  it("closes a clean image with Ctrl+W without asking, then shows the empty state (UI-DOC-03)", async () => {
    vi.mocked(SettingsStore.open).mockImplementation(() => openMemorySettings(true));
    render(<App />);
    await waitFor(() => expect(document.title).toBe("Untitled - OpenPaint"));
    fireEvent.keyDown(document.body, { code: "KeyW", ctrlKey: true });
    expect(screen.queryByRole("dialog", { name: "Unsaved Changes" })).toBeNull();
    expect(document.title).toBe("OpenPaint");
  });
});
