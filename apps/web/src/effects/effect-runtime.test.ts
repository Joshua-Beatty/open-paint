/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document, type Layer, Selection, Surface } from "@openpaint/document";
import {
  ALIGN_OBJECT_ID,
  builtinEffectBindings,
  type EffectBinding,
  EffectMemory,
  type EffectValueStore,
  FLIP_HORIZONTAL_ID,
  FLIP_VERTICAL_ID,
  GAUSSIAN_BLUR_ID,
  registerBuiltinEffects,
} from "@openpaint/effects";
import { type EffectDescriptor, EffectRegistry } from "@openpaint/extension-api";
import { t } from "@openpaint/i18n";
import { definePropertySchema, type PropertyValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { BUILT_IN_REGISTRY } from "../commands/catalog";
import { ShortcutController } from "../commands/shortcuts";
import {
  registerAdjustmentCommands,
  registerEffectCommands,
  registerRotateZoomCommand,
} from "./effect-commands";
import { EffectRuntime, type EffectRuntimeOptions } from "./effect-runtime";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const SIZE = 12;

function memoryValues(): EffectValueStore & { readonly values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get: (id) => values.get(id),
    set: (id, _category, stored) => values.set(id, stored),
  };
}

function blurValues(radius: number): PropertyValues {
  return { radius, gammaBoost: 0, quality: 4 };
}

interface Fixture {
  readonly doc: Document;
  readonly layer: Layer;
  readonly store: ReturnType<typeof memoryValues>;
  readonly runtime: EffectRuntime;
  readonly registry: EffectRegistry;
  readonly bindings: EffectBinding<unknown>[];
}

function fixture(overrides: Partial<EffectRuntimeOptions> = {}): Fixture {
  const doc = Document.createBlank({ width: SIZE, height: SIZE });
  const layer = doc.activeLayer;
  if (layer === undefined) throw new Error("The new document has no layer.");
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) data.set([(i * 9) % 256, (i * 5) % 256, 40, 255], i * 4);
  layer.pixels.writeRegion(new Surface(SIZE, SIZE, data), 0, 0);
  const store = memoryValues();
  const registry = new EffectRegistry();
  registerBuiltinEffects(registry, 2);
  const bindings = builtinEffectBindings(2) as EffectBinding<unknown>[];
  const runtime = new EffectRuntime({
    registry,
    bindings,
    memory: new EffectMemory(store),
    document: () => doc,
    translate: t,
    backend: () => "cpu",
    log: () => undefined,
    ...overrides,
  });
  return { doc, layer, store, runtime, registry, bindings };
}

/** Waits until no run is in flight and no dialog is open, including a run with no dialog. */
async function settled(runtime: EffectRuntime): Promise<void> {
  await vi.waitFor(() => expect(runtime.canStart).toBe(true));
}

function pixels(layer: Layer): number[] {
  return [...layer.pixels.readRegion(layer.pixels.bounds).data];
}

describe("EffectRuntime", () => {
  it("opens the generated dialog with the remembered values and previews into the layer", async () => {
    const { runtime, layer, store } = fixture();
    const original = pixels(layer);
    store.set(GAUSSIAN_BLUR_ID, "effect", { radius: 5, gammaBoost: 0, quality: 4 } as never);
    runtime.start(GAUSSIAN_BLUR_ID);
    const state = runtime.state;
    expect(state?.phase).toBe("dialog");
    if (state?.phase !== "dialog") throw new Error("expected the dialog");
    expect(state.title).toBe("Gaussian Blur");
    expect(state.values.radius).toBe(5);
    await vi.waitFor(() => expect(pixels(layer)).not.toEqual(original));
  });

  it("tells the document's listeners about every live preview, so it reaches the canvas", async () => {
    const { runtime, layer, doc } = fixture();
    const original = pixels(layer);
    const shown: number[][] = [];
    doc.subscribe(() => shown.push(pixels(layer)));
    expect(runtime.active).toBe(false);
    runtime.start(GAUSSIAN_BLUR_ID);
    expect(runtime.active).toBe(true);
    await vi.waitFor(() => expect(shown.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(runtime.rendering).toBe(false));
    expect(shown.at(-1)).not.toEqual(original);
    expect(shown.at(-1)).toEqual(pixels(layer));

    runtime.preview(blurValues(9));
    const nine = shown.length;
    await vi.waitFor(() => expect(shown.length).toBeGreaterThan(nine));
    await vi.waitFor(() => expect(runtime.rendering).toBe(false));
    expect(shown.at(-1)).toEqual(pixels(layer));

    runtime.cancel();
    await settled(runtime);
    expect(runtime.active).toBe(false);
    expect(shown.at(-1)).toEqual(original);
  });

  it("previews once per frame with the newest values, and OK drops a preview still waiting (L1)", async () => {
    const frames: (() => void)[] = [];
    const { runtime, layer } = fixture({
      liveFilters: true,
      scheduleFrame: (callback) => {
        frames.push(callback);
        return () => frames.splice(frames.indexOf(callback), 1);
      },
    });
    const original = pixels(layer);
    runtime.start("hueSaturation");
    await vi.waitFor(() => expect(layer.livePreview).toBeDefined());
    for (const saturation of [150, 120, 40]) runtime.preview({ hue: 0, saturation, lightness: 0 });
    expect(frames).toHaveLength(1);
    frames.shift()?.();
    await vi.waitFor(() =>
      expect(layer.livePreview?.params).toEqual({ hue: 0, saturation: 40, lightness: 0 }),
    );
    // The canvas draws the preview; the layer keeps its pixels.
    expect(pixels(layer)).toEqual(original);

    runtime.preview({ hue: 0, saturation: 90, lightness: 0 });
    runtime.ok({ hue: 0, saturation: 0, lightness: 0 });
    expect(frames).toHaveLength(0);
    await settled(runtime);
    expect(layer.livePreview).toBeUndefined();
    expect(pixels(layer)).not.toEqual(original);
  });

  it("Cancel restores the original pixels and records nothing", async () => {
    const { runtime, layer, doc, store } = fixture();
    const original = pixels(layer);
    runtime.start(GAUSSIAN_BLUR_ID);
    runtime.preview(blurValues(7));
    await runtime.cancel();
    await settled(runtime);
    expect(pixels(layer)).toEqual(original);
    expect(doc.history.undoName).toBeUndefined();
    expect(store.values.size).toBe(0);
    expect(runtime.canRepeat).toBe(false);
  });

  it("OK commits one history item, remembers the values and enables Repeat", async () => {
    const { runtime, doc, store } = fixture();
    runtime.start(GAUSSIAN_BLUR_ID);
    runtime.ok(blurValues(4));
    await settled(runtime);
    expect(doc.history.undoName).toBe("Gaussian Blur");
    expect(store.values.has(GAUSSIAN_BLUR_ID)).toBe(true);
    expect(runtime.lastEffectId).toBe(GAUSSIAN_BLUR_ID);
    expect(runtime.canRepeat).toBe(true);
  });

  it("Repeat re-runs the last effect with its stored values and no dialog", async () => {
    const { runtime, doc, layer } = fixture();
    runtime.start(GAUSSIAN_BLUR_ID);
    runtime.ok(blurValues(3));
    await settled(runtime);
    const once = pixels(layer);
    runtime.repeat();
    expect(runtime.state).toBeUndefined();
    await settled(runtime);
    expect(doc.history.entries.length).toBe(3);
    expect(pixels(layer)).not.toEqual(once);
  });

  it("ignores a start with no open image", () => {
    const { runtime } = fixture({ document: () => undefined });
    runtime.start(GAUSSIAN_BLUR_ID);
    expect(runtime.state).toBeUndefined();
  });

  it("shows an error and leaves the image unchanged when the effect fails", async () => {
    const failing = builtinEffectBindings(2).map((binding) =>
      binding.descriptor.id === GAUSSIAN_BLUR_ID
        ? ({
            ...binding,
            cpu: () => {
              throw new Error("broken");
            },
          } as EffectBinding<unknown>)
        : (binding as EffectBinding<unknown>),
    );
    const log = vi.fn();
    const { runtime, layer, doc } = fixture({ bindings: failing, log });
    const original = pixels(layer);
    runtime.start(GAUSSIAN_BLUR_ID);
    runtime.ok(blurValues(2));
    await vi.waitFor(() => expect(runtime.state?.phase).toBe("error"));
    expect(runtime.state).toEqual({
      phase: "error",
      title: "Gaussian Blur",
      message: "Gaussian Blur could not be applied. Your image has not been changed.",
      details: expect.stringContaining("broken"),
    });
    expect(log).toHaveBeenCalledWith(
      'The effect "Gaussian Blur" failed.',
      expect.objectContaining({ message: "broken" }),
    );
    expect(pixels(layer)).toEqual(original);
    expect(doc.history.undoName).toBeUndefined();
    runtime.dismissError();
    expect(runtime.state).toBeUndefined();
  });

  it("runs a non-configurable effect at once with no dialog", async () => {
    const base = builtinEffectBindings(2)[0] as EffectBinding<unknown>;
    const descriptor = {
      ...base.descriptor,
      id: "plain",
      configurable: false,
      schema: definePropertySchema({ properties: [] }),
    } as EffectDescriptor;
    const registry = new EffectRegistry();
    registry.register(descriptor);
    const plain: EffectBinding<unknown> = {
      descriptor,
      params: () => undefined,
      cpu: (input) => {
        const data = new Uint8ClampedArray(input.data);
        for (let i = 0; i < data.length; i += 4) data[i] = 255 - (data[i] ?? 0);
        return new Surface(input.width, input.height, data);
      },
    };
    const { runtime, doc, layer } = fixture({ registry, bindings: [plain] });
    const original = pixels(layer);
    runtime.start("plain");
    expect(runtime.state).toBeUndefined();
    await settled(runtime);
    expect(pixels(layer)).not.toEqual(original);
    expect(doc.history.undoName).toBe("Gaussian Blur");
  });

  it("refuses a second start while a run with no dialog is still going", async () => {
    const base = builtinEffectBindings(2)[0] as EffectBinding<unknown>;
    const descriptor = {
      ...base.descriptor,
      id: "plain",
      configurable: false,
      schema: definePropertySchema({ properties: [] }),
    } as EffectDescriptor;
    const registry = new EffectRegistry();
    registry.register(descriptor);
    const plain: EffectBinding<unknown> = {
      descriptor,
      params: () => undefined,
      cpu: (input) => input,
    };
    const { runtime, doc } = fixture({ registry, bindings: [plain] });
    runtime.start("plain");
    runtime.start("plain");
    await settled(runtime);
    expect(doc.history.entries.length).toBe(2);
  });

  it("does not offer Repeat from an adjustment", async () => {
    const base = builtinEffectBindings(2)[0] as EffectBinding<unknown>;
    const descriptor = {
      ...base.descriptor,
      id: "soft",
      category: "adjustment",
      configurable: false,
      schema: definePropertySchema({ properties: [] }),
    } as EffectDescriptor;
    const registry = new EffectRegistry();
    registry.register(descriptor);
    const adjust: EffectBinding<unknown> = {
      descriptor,
      params: () => undefined,
      cpu: (input) => input,
    };
    const { runtime } = fixture({ registry, bindings: [adjust] });
    runtime.start("soft");
    await settled(runtime);
    expect(runtime.lastEffectId).toBeUndefined();
    expect(runtime.canRepeat).toBe(false);
  });
});

describe("registerEffectCommands", () => {
  it("binds Repeat Last Effect to the runtime with the enable rule", async () => {
    const { runtime } = fixture();
    const controller = new ShortcutController(BUILT_IN_REGISTRY, "other");
    const release = registerEffectCommands(controller, runtime);
    expect(controller.isEnabled("effects.repeat")).toBe(false);
    runtime.start(GAUSSIAN_BLUR_ID);
    runtime.ok(blurValues(2));
    await settled(runtime);
    expect(controller.isEnabled("effects.repeat")).toBe(true);
    expect(controller.invoke("effects.repeat")).toBe(true);
    await settled(runtime);
    release();
    expect(controller.isEnabled("effects.repeat")).toBe(false);
  });
});

describe("registerRotateZoomCommand", () => {
  it("opens the hidden Rotate / Zoom dialog from its shortcut, remembers OK, and is not the Repeat target", async () => {
    const { runtime, doc, store } = fixture();
    const controller = new ShortcutController(BUILT_IN_REGISTRY, "other");
    const release = registerRotateZoomCommand(controller, runtime);
    expect(controller.isEnabled("layers.rotateZoom")).toBe(true);
    expect(controller.invoke("layers.rotateZoom")).toBe(true);
    const state = runtime.state;
    expect(state).toMatchObject({ phase: "dialog", title: "Rotate / Zoom" });
    runtime.ok({
      roll: { x: 0, y: 0, z: 0 },
      pan: { x: 0, y: 0 },
      zoom: 1,
      sampling: "bilinear",
      quality: 1,
      tiling: "none",
    });
    await settled(runtime);
    expect(doc.history.undoName).toBe("Rotate / Zoom");
    expect(store.values.has("rotate-zoom")).toBe(true);
    expect(runtime.lastEffectId).toBeUndefined();
    release();
    expect(controller.isEnabled("layers.rotateZoom")).toBe(false);
  });
});

describe("EffectRuntime custom dialogs", () => {
  it("hands Levels its custom dialog token and the pixels it reads", async () => {
    const { runtime, layer } = fixture();
    const before = pixels(layer);
    runtime.start("levels");
    const state = runtime.state;
    expect(state).toMatchObject({ phase: "dialog", customDialog: "levels" });
    if (state?.phase !== "dialog") throw new Error("Levels should open its dialog.");
    expect(state.source?.pixels.width).toBe(SIZE);
    expect(state.source?.coverage).toBeUndefined();
    runtime.cancel();
    await settled(runtime);
    expect(pixels(layer)).toEqual(before);
  });

  it("gives the generated dialog no token for an effect without one", async () => {
    const { runtime } = fixture();
    runtime.start("posterize");
    const state = runtime.state;
    expect(state).toMatchObject({ phase: "dialog" });
    if (state?.phase !== "dialog") throw new Error("Posterize should open its dialog.");
    expect(state.customDialog).toBeUndefined();
    runtime.cancel();
    await settled(runtime);
  });
});

describe("registerAdjustmentCommands", () => {
  it("runs an adjustment from its shortcut, with no menu open, and leaves Repeat alone", async () => {
    const { runtime, layer, registry } = fixture();
    const controller = new ShortcutController(BUILT_IN_REGISTRY, "other");
    const release = registerAdjustmentCommands(controller, runtime, registry);
    expect(controller.isEnabled("adjustments.invertColors")).toBe(true);
    const before = pixels(layer);
    expect(controller.invoke("adjustments.invertColors")).toBe(true);
    await settled(runtime);
    expect(pixels(layer)).not.toEqual(before);
    expect(runtime.lastEffectId).toBeUndefined();
    release();
    expect(controller.isEnabled("adjustments.invertColors")).toBe(false);
  });

  it("binds only the adjustments the registry holds", () => {
    const { runtime } = fixture();
    const controller = new ShortcutController(BUILT_IN_REGISTRY, "other");
    registerAdjustmentCommands(controller, runtime, new EffectRegistry());
    expect(controller.isEnabled("adjustments.invertColors")).toBe(false);
    expect(controller.isEnabled("adjustments.sepia")).toBe(false);
  });
});

describe("EffectRuntime with Flip Horizontal and Flip Vertical (FX-OBJ-FLIP-05)", () => {
  it("runs with no dialog as one named step, and Repeat flips back", async () => {
    const { runtime, layer, doc } = fixture();
    const original = pixels(layer);
    doc.replaceSelection(
      new Selection([[1, 1, 4, 1, 4, 6, 9, 6, 9, 8, 1, 8]], "aliased"),
      "Lasso Select",
    );
    const selection = doc.selection;
    runtime.start(FLIP_HORIZONTAL_ID);
    expect(runtime.state).toBeUndefined();
    await settled(runtime);
    expect(doc.history.undoName).toBe("Flip Horizontal");
    expect(pixels(layer)).not.toEqual(original);
    expect(doc.selection).not.toBe(selection);
    expect(runtime.lastEffectId).toBe(FLIP_HORIZONTAL_ID);

    runtime.repeat();
    await settled(runtime);
    expect(doc.history.undoName).toBe("Flip Horizontal");
    expect(pixels(layer)).not.toEqual(original);
    expect(doc.selection.mask(selection.bounds())).toEqual(selection.mask(selection.bounds()));

    await doc.history.undo();
    await doc.history.undo();
    expect(pixels(layer)).toEqual(original);
    expect(doc.selection).toBe(selection);
  });

  it("flips the whole layer top to bottom with nothing selected", async () => {
    const { runtime, layer, doc } = fixture();
    const before = layer.pixels.readRegion(layer.pixels.bounds);
    runtime.start(FLIP_VERTICAL_ID);
    await settled(runtime);
    expect(doc.history.undoName).toBe("Flip Vertical");
    const after = layer.pixels.readRegion(layer.pixels.bounds);
    const row = (surface: Surface, y: number) => [
      ...surface.data.slice(y * SIZE * 4, (y + 1) * SIZE * 4),
    ];
    expect(row(after, 0)).toEqual(row(before, SIZE - 1));
    expect(row(after, 4)).toEqual(row(before, SIZE - 5));
  });
});

describe("EffectRuntime with Align Object (FX-OBJ-ALIGN-06)", () => {
  it("shows the filled notice on an opaque layer, and OK records no history step", async () => {
    const { runtime, layer, doc } = fixture();
    const original = pixels(layer);
    runtime.start(ALIGN_OBJECT_ID);
    const state = runtime.state;
    if (state?.phase !== "dialog") throw new Error("expected the dialog");
    expect(state.title).toBe("Align Object");
    expect(state.notice).toBe(t("effect.alignObject.filled"));
    runtime.ok({ position: "topLeft", showFaintPixels: false });
    await settled(runtime);
    expect(pixels(layer)).toEqual(original);
    expect(doc.history.undoName).toBeUndefined();
  });

  it("shows no notice when there is an object to align", () => {
    const { runtime, layer } = fixture();
    const object = new Surface(SIZE, SIZE);
    object.data.set([255, 0, 0, 255], (3 * SIZE + 4) * 4);
    layer.pixels.writeRegion(object, 0, 0);
    runtime.start(ALIGN_OBJECT_ID);
    const state = runtime.state;
    if (state?.phase !== "dialog") throw new Error("expected the dialog");
    expect(state.notice).toBeUndefined();
    runtime.cancel();
  });
});
