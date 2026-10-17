import type { SettingChange, SettingsListener, SettingValue } from "@openpaint/storage";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_REGISTRY, type BuiltInCommandId } from "../commands/catalog";
import { ShortcutController } from "../commands/shortcuts";
import { ColorsPanel } from "./ColorsPanel";
import { BLACK, WHITE } from "./color-math";
import { DEFAULT_PALETTE, serializePalette } from "./palette";
import { memoryPaletteStorage, type PaletteStorage } from "./palette-library";
import type { ColorSettings } from "./use-colors";

interface FakeSettings {
  readonly settings: ColorSettings;
  readonly values: Map<string, SettingValue>;
}

/** An in-memory settings store with the three methods the panel uses. */
function fakeSettings(initial: Record<string, SettingValue> = {}): FakeSettings {
  const values = new Map<string, SettingValue>(Object.entries(initial));
  const listeners = new Set<SettingsListener>();
  const settings: ColorSettings = {
    get: (path) => values.get(path),
    set: (path, value) => {
      values.set(path, value);
      for (const listener of listeners) listener({ path, value } as SettingChange);
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return { settings, values };
}

function stored(values: Map<string, SettingValue>, path: string): unknown {
  return values.get(path);
}

const RED = { r: 255, g: 0, b: 0, a: 255 };
const GREEN = { r: 0, g: 255, b: 0, a: 255 };

interface Harness {
  readonly commands: ShortcutController<BuiltInCommandId>;
  readonly storage: PaletteStorage;
  readonly values: Map<string, SettingValue>;
  readonly onExpandedChange: ReturnType<typeof vi.fn<(expanded: boolean) => void>>;
  readonly onRelinquish: ReturnType<typeof vi.fn<() => void>>;
  readonly container: HTMLElement;
}

function renderPanel(
  options: {
    expanded?: boolean;
    storage?: PaletteStorage;
    initial?: Record<string, SettingValue>;
  } = {},
): Harness {
  const fake = fakeSettings(options.initial);
  const storage = options.storage ?? memoryPaletteStorage();
  const commands = new ShortcutController(BUILT_IN_REGISTRY, "other");
  const onExpandedChange = vi.fn<(expanded: boolean) => void>();
  const onRelinquish = vi.fn<() => void>();
  const { container } = render(
    <ColorsPanel
      settings={fake.settings}
      storage={storage}
      commands={commands}
      expanded={options.expanded ?? false}
      onExpandedChange={onExpandedChange}
      onRelinquish={onRelinquish}
    />,
  );
  return { commands, storage, values: fake.values, onExpandedChange, onRelinquish, container };
}

function swatch(index: number): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^Palette color ${index + 1}:`) });
}

function openPaletteMenu(): void {
  fireEvent.click(screen.getByRole("button", { name: "Palettes" }));
}

function chooseMenuItem(name: string): void {
  openPaletteMenu();
  fireEvent.click(screen.getByRole("menuitem", { name }));
}

function inputValue(element: HTMLElement): string {
  return (element as HTMLInputElement).value;
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ColorsPanel: swatches and colors", () => {
  it("shows the 96 default swatches and the default black and white", () => {
    renderPanel();
    expect(screen.getAllByRole("button", { name: /^Palette color \d+:/ })).toHaveLength(96);
    expect(swatch(0).getAttribute("aria-label")).toBe("Palette color 1: FF000000");
    expect(swatch(2).getAttribute("aria-label")).toBe("Palette color 3: FFFF0000");
  });

  it("lays the palette out 16 swatches wide, so the default palette's rows line up", () => {
    renderPanel();
    const palette = screen.getByRole("group", { name: "Palette" });
    expect(palette.style.gridTemplateColumns).toMatch(/^repeat\(16, /);
  });

  it("sets the primary color from a left click and the secondary from a right click", () => {
    const harness = renderPanel();
    fireEvent.click(swatch(2));
    expect(stored(harness.values, "tools.primaryColor")).toEqual(RED);
    fireEvent.contextMenu(swatch(1));
    expect(stored(harness.values, "tools.secondaryColor")).toEqual({
      r: 64,
      g: 64,
      b: 64,
      a: 255,
    });
  });

  it("returns focus to the canvas after a pointer click, but not after a keyboard one", () => {
    const harness = renderPanel();
    fireEvent.click(swatch(2), { detail: 0 });
    expect(harness.onRelinquish).not.toHaveBeenCalled();
    fireEvent.click(swatch(2), { detail: 1 });
    expect(harness.onRelinquish).toHaveBeenCalledTimes(1);
  });

  it("swaps the colors with the swap command and resets them with the reset button", () => {
    const harness = renderPanel();
    fireEvent.click(swatch(2));
    act(() => {
      harness.commands.invoke("tools.swapColors");
    });
    expect(stored(harness.values, "tools.primaryColor")).toEqual(WHITE);
    expect(stored(harness.values, "tools.secondaryColor")).toEqual(RED);
    fireEvent.click(screen.getByRole("button", { name: "Reset to black and white" }));
    expect(stored(harness.values, "tools.primaryColor")).toEqual(BLACK);
    expect(stored(harness.values, "tools.secondaryColor")).toEqual(WHITE);
  });

  it("toggles the target with the C command, so the sliders edit the other color", () => {
    const harness = renderPanel({ expanded: true });
    expect(inputValue(screen.getByRole("textbox", { name: "Red" }))).toBe("0");
    act(() => {
      harness.commands.invoke("tools.toggleColorTarget");
    });
    expect(inputValue(screen.getByRole("textbox", { name: "Red" }))).toBe("255");
  });

  it("stores a color in the clicked slot in add mode, then leaves add mode", () => {
    renderPanel();
    fireEvent.click(swatch(2));
    const add = () => screen.getByRole("button", { name: "Add color to palette" });
    fireEvent.click(add());
    expect(add().getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(swatch(9));
    expect(swatch(9).getAttribute("aria-label")).toBe("Palette color 10: FFFF0000");
    expect(add().getAttribute("aria-pressed")).toBe("false");
  });

  it("deletes a slot to white with Shift+click or the Delete key", () => {
    renderPanel();
    fireEvent.click(swatch(0), { shiftKey: true });
    expect(swatch(0).getAttribute("aria-label")).toBe("Palette color 1: FFFFFFFF");
    fireEvent.keyDown(swatch(1), { key: "Delete" });
    expect(swatch(1).getAttribute("aria-label")).toBe("Palette color 2: FFFFFFFF");
  });

  it("shows the editor and the More button only in the expanded mode", () => {
    const compact = renderPanel();
    expect(screen.queryByRole("img", { name: "Color wheel" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More >>" }));
    expect(compact.onExpandedChange).toHaveBeenCalledWith(true);
    cleanup();
    renderPanel({ expanded: true });
    expect(screen.getByRole("img", { name: "Color wheel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "<< Less" })).toBeTruthy();
  });
});

describe("ColorsPanel: the editor", () => {
  it("keeps the hex box, the RGB and HSV fields and the alpha field in step", () => {
    const harness = renderPanel({ expanded: true });
    const hex = screen.getByRole("textbox", { name: "Hex:" });
    fireEvent.change(hex, { target: { value: "#ff8000" } });
    fireEvent.blur(hex);
    expect(stored(harness.values, "tools.primaryColor")).toEqual({
      r: 255,
      g: 128,
      b: 0,
      a: 255,
    });
    expect(inputValue(screen.getByRole("textbox", { name: "Green" }))).toBe("128");
    expect(inputValue(screen.getByRole("textbox", { name: "Hue" }))).toBe("30");
  });

  it("reverts an invalid hex entry when the box loses focus", () => {
    const harness = renderPanel({ expanded: true });
    const hex = screen.getByRole("textbox", { name: "Hex:" });
    fireEvent.change(hex, { target: { value: "zz" } });
    fireEvent.blur(hex);
    expect(inputValue(hex)).toBe("000000");
    expect(stored(harness.values, "tools.primaryColor")).toBeUndefined();
  });

  it("edits the hue through the spin box", () => {
    const harness = renderPanel({ expanded: true, initial: { "tools.primaryColor": RED } });
    const hue = screen.getByRole("textbox", { name: "Hue" });
    fireEvent.change(hue, { target: { value: "120" } });
    fireEvent.blur(hue);
    expect(stored(harness.values, "tools.primaryColor")).toEqual(GREEN);
  });

  it("edits the alpha through the spin box", () => {
    const harness = renderPanel({ expanded: true });
    const alpha = screen.getByRole("textbox", { name: "Alpha" });
    fireEvent.change(alpha, { target: { value: "128" } });
    fireEvent.blur(alpha);
    expect(stored(harness.values, "tools.primaryColor")).toEqual({ ...BLACK, a: 128 });
  });
});

describe("ColorsPanel: palettes", () => {
  it("saves the shown colors under a new name and makes it current", async () => {
    const harness = renderPanel();
    chooseMenuItem("Save Current Palette As…");
    fireEvent.change(screen.getByRole("textbox", { name: "Type a name for the palette:" }), {
      target: { value: "Sky" },
    });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(async () => {
      expect(await harness.storage.list()).toEqual(["Sky"]);
    });
    expect(await screen.findByText("Sky", { selector: ".color-palette-name" })).toBeTruthy();
    expect(stored(harness.values, "workspace.currentPalette")).toBe("Sky");
  });

  it("refuses an empty name and a name with a character that file names cannot hold", async () => {
    const harness = renderPanel();
    chooseMenuItem("Save Current Palette As…");
    const field = screen.getByRole("textbox", { name: "Type a name for the palette:" });
    fireEvent.change(field, { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.getByText("The palette name cannot be empty.")).toBeTruthy();
    fireEvent.change(field, { target: { value: "a/b" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.getByText(/cannot contain these characters/)).toBeTruthy();
    expect(await harness.storage.list()).toEqual([]);
  });

  it("asks before replacing a palette, and keeps it when the answer is Cancel", async () => {
    const storage = memoryPaletteStorage({ Sky: serializePalette([RED]) });
    const harness = renderPanel({ storage });
    chooseMenuItem("Save Current Palette As…");
    fireEvent.change(screen.getByRole("textbox", { name: "Type a name for the palette:" }), {
      target: { value: "Sky" },
    });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(
      await screen.findByText('A palette named "Sky" already exists. Do you want to replace it?'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByText(/already exists/)).toBeNull();
    });
    expect(await storage.read("Sky")).toBe(serializePalette([RED]));
    expect(stored(harness.values, "workspace.currentPalette")).toBeUndefined();
  });

  it("replaces a palette when the answer is Replace", async () => {
    const storage = memoryPaletteStorage({ Sky: serializePalette([RED]) });
    renderPanel({ storage });
    chooseMenuItem("Save Current Palette As…");
    fireEvent.change(screen.getByRole("textbox", { name: "Type a name for the palette:" }), {
      target: { value: "Sky" },
    });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace" }));
    await waitFor(async () => {
      expect(await storage.read("Sky")).toBe(serializePalette(DEFAULT_PALETTE));
    });
  });

  it("lists the saved palettes and fills the name when one is clicked", async () => {
    const storage = memoryPaletteStorage({ Dusk: serializePalette([RED]) });
    renderPanel({ storage });
    openPaletteMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Save Current Palette As…" }));
    fireEvent.click(screen.getByRole("button", { name: "Dusk" }));
    expect(
      (screen.getByRole("textbox", { name: "Type a name for the palette:" }) as HTMLInputElement)
        .value,
    ).toBe("Dusk");
  });

  it("loads a saved palette from the menu and shows its colors", async () => {
    const storage = memoryPaletteStorage({ Dusk: serializePalette([GREEN]) });
    const harness = renderPanel({ storage });
    openPaletteMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Dusk" }));
    await waitFor(() => {
      expect(swatch(0).getAttribute("aria-label")).toBe("Palette color 1: FF00FF00");
    });
    expect(stored(harness.values, "workspace.currentPalette")).toBe("Dusk");
  });

  it("writes an edit to the current user palette", async () => {
    const storage = memoryPaletteStorage({ Dusk: serializePalette([GREEN]) });
    renderPanel({ storage, initial: { "workspace.currentPalette": "Dusk" } });
    await screen.findByText("Dusk", { selector: ".color-palette-name" });
    fireEvent.click(swatch(0), { shiftKey: true });
    await waitFor(async () => {
      expect((await storage.read("Dusk"))?.split("\r\n")[7]).toBe("FFFFFFFF");
    });
  });

  it("renames the current palette, keeping its colors", async () => {
    const storage = memoryPaletteStorage({ Sky: serializePalette([RED]) });
    renderPanel({ storage, initial: { "workspace.currentPalette": "Sky" } });
    await screen.findByText("Sky", { selector: ".color-palette-name" });
    chooseMenuItem("Rename Current Palette…");
    const field = screen.getByRole("textbox", { name: "Type a name for the palette:" });
    expect((field as HTMLInputElement).value).toBe("Sky");
    fireEvent.change(field, { target: { value: "Ocean" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(async () => {
      expect(await storage.list()).toEqual(["Ocean"]);
    });
    expect((await storage.read("Ocean"))?.split("\r\n")[7]).toBe("FFFF0000");
  });

  it("deletes the current palette after a confirmation and makes the default current", async () => {
    const storage = memoryPaletteStorage({ Sky: serializePalette([RED]) });
    const harness = renderPanel({ storage, initial: { "workspace.currentPalette": "Sky" } });
    await screen.findByText("Sky", { selector: ".color-palette-name" });
    chooseMenuItem("Delete Current Palette…");
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(async () => {
      expect(await storage.list()).toEqual([]);
    });
    expect(stored(harness.values, "workspace.currentPalette")).toBe("");
    expect(
      await screen.findByText("Default Palette", { selector: ".color-palette-name" }),
    ).toBeTruthy();
  });

  it("disables rename and delete while the default palette is current", () => {
    renderPanel();
    openPaletteMenu();
    const disabled = (name: string) =>
      screen.getByRole("menuitem", { name }).getAttribute("aria-disabled");
    expect(disabled("Rename Current Palette…")).toBe("true");
    expect(disabled("Delete Current Palette…")).toBe("true");
  });

  it("renames and deletes a palette from its own context menu, not the current one", async () => {
    const storage = memoryPaletteStorage({
      Dusk: serializePalette([GREEN]),
      Sky: serializePalette([RED]),
    });
    const harness = renderPanel({ storage });
    openPaletteMenu();
    fireEvent.contextMenu(await screen.findByText("Dusk", { selector: ".app-menu-label" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename Palette…" }));
    const field = screen.getByRole("textbox", { name: "Type a name for the palette:" });
    expect((field as HTMLInputElement).value).toBe("Dusk");
    fireEvent.change(field, { target: { value: "Dawn" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(async () => {
      expect((await storage.list()).sort()).toEqual(["Dawn", "Sky"]);
    });
    expect(stored(harness.values, "workspace.currentPalette")).toBeUndefined();

    openPaletteMenu();
    fireEvent.contextMenu(await screen.findByText("Sky", { selector: ".app-menu-label" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete Palette…" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(async () => {
      expect(await storage.list()).toEqual(["Dawn"]);
    });
    expect(stored(harness.values, "workspace.currentPalette")).toBeUndefined();
  });

  it("resets to the default palette from the menu", async () => {
    const storage = memoryPaletteStorage({ Dusk: serializePalette([GREEN]) });
    const harness = renderPanel({ storage, initial: { "workspace.currentPalette": "Dusk" } });
    await screen.findByText("Dusk", { selector: ".color-palette-name" });
    chooseMenuItem("Reset to Default Palette");
    await waitFor(() => {
      expect(swatch(0).getAttribute("aria-label")).toBe("Palette color 1: FF000000");
    });
    expect(stored(harness.values, "workspace.currentPalette")).toBe("");
  });

  it("imports palette files dropped on the panel", async () => {
    const storage = memoryPaletteStorage();
    const harness = renderPanel({ storage });
    const file = new File(["FF0000FF\n"], "Ocean.txt", { type: "text/plain" });
    const other = new File(["not a palette"], "photo.png", { type: "image/png" });
    fireEvent.drop(harness.container.firstElementChild as Element, {
      dataTransfer: { files: [file, other], items: [] },
    });
    await waitFor(async () => {
      expect(await storage.list()).toEqual(["Ocean"]);
    });
    expect((await storage.read("Ocean"))?.split("\r\n")[7]).toBe("FF0000FF");
  });

  it("exports the current palette as a .txt file named after it", () => {
    const createObjectURL = vi.fn(() => "blob:palette");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
    });
    renderPanel();
    chooseMenuItem("Export Current Palette…");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(downloads).toEqual(["Default Palette.txt"]);
  });
});
