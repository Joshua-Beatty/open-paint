/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document, type Layer, rect, rectPolygon, Surface } from "@openpaint/document";
import { EffectRegistry } from "@openpaint/extension-api";
import { defaultValues, type PropertyValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ALIGN_OBJECT_ID,
  ALIGN_POSITION_ORDER,
  ALIGN_POSITIONS,
  type AlignObjectParams,
  alignObjectBinding,
  alignObjectCpu,
  alignObjectDescriptor,
  alignObjectNotice,
  alignObjectParams,
  alignObjectSchema,
  analyzeAlignObject,
  builtinEffectBindings,
  EffectMemory,
  EffectSession,
  type EffectSessionOptions,
  type EffectValueStore,
  planAlignObject,
  registerBuiltinEffects,
} from "./index";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const RED = [200, 10, 20, 255] as const;
const FAINT = [30, 40, 50, 3] as const;

/** A transparent image with the given pixels set. */
function image(
  width: number,
  height: number,
  pixels: readonly (readonly [number, number, readonly number[]])[],
): Surface {
  const surface = new Surface(width, height);
  for (const [x, y, rgba] of pixels) surface.data.set(rgba, (y * width + x) * 4);
  return surface;
}

function pixel(surface: Surface, x: number, y: number): number[] {
  const i = (y * surface.width + x) * 4;
  return [...surface.data.slice(i, i + 4)];
}

/** The positions of every pixel with alpha above 0. */
function visible(surface: Surface): [number, number][] {
  const found: [number, number][] = [];
  for (let i = 0; i < surface.width * surface.height; i++) {
    if ((surface.data[i * 4 + 3] ?? 0) > 0)
      found.push([i % surface.width, Math.floor(i / surface.width)]);
  }
  return found;
}

describe("Align Object descriptor and schema (FX-OBJ-ALIGN-01, FX-OBJ-ALIGN-02)", () => {
  it("is a configurable GPU effect in the Object submenu with an aliased, self-clipped selection", () => {
    expect(alignObjectDescriptor()).toMatchObject({
      id: ALIGN_OBJECT_ID,
      label: "effect.alignObject",
      category: "effect",
      submenu: "object",
      configurable: true,
      kind: "gpuImage",
      options: {
        forceAliasedSelection: true,
        disableSelectionClipping: true,
        previewOnlyProperties: ["showFaintPixels"],
        openAtDefaultProperties: ["position"],
      },
    });
  });

  it("offers the 16 positions as a grid of icon buttons, defaulting to Original Position", () => {
    const [position, faint] = alignObjectSchema().properties;
    expect(position).toMatchObject({
      kind: "choice",
      key: "position",
      label: "property.position",
      defaultValue: "original",
      control: { controlType: "radioButtons", dialogHelpMessage: "property.alignObjectHelp" },
    });
    const options = position?.kind === "choice" ? position.options : [];
    expect(options.map((option) => option.value)).toEqual([
      "topLeft",
      "middleTop",
      "topRight",
      "middleLeft",
      "center",
      "middleRight",
      "bottomLeft",
      "middleBottom",
      "bottomRight",
      "left",
      "centerHorizontally",
      "right",
      "top",
      "centerVertically",
      "bottom",
      "original",
    ]);
    expect(options.map((option) => option.label)).toEqual(
      ALIGN_POSITION_ORDER.map((value) => `alignPosition.${value}`),
    );
    expect(new Set(ALIGN_POSITION_ORDER)).toEqual(new Set(ALIGN_POSITIONS));
    expect(options.every((option) => typeof option.icon === "string")).toBe(true);
    const grid = position?.control?.choiceGrid;
    expect(grid?.rows).toEqual([
      ["left", "centerHorizontally", "right", "original"],
      ["topLeft", "middleTop", "topRight", "top"],
      ["middleLeft", "center", "middleRight", "centerVertically"],
      ["bottomLeft", "middleBottom", "bottomRight", "bottom"],
    ]);
    expect(grid).toMatchObject({ gapAfterRows: [0], gapAfterColumns: [2] });
    expect(faint).toMatchObject({
      kind: "boolean",
      key: "showFaintPixels",
      defaultValue: false,
      control: { description: "property.showFaintPixels", footnote: "property.alignObjectNote" },
    });
    expect(defaultValues(alignObjectSchema())).toEqual({
      position: "original",
      showFaintPixels: false,
    });
  });

  it("reads the parameters, falling back to Original Position for an unknown position", () => {
    expect(alignObjectParams({ position: "bottomRight", showFaintPixels: true })).toEqual({
      position: "bottomRight",
      showFaintPixels: true,
    });
    expect(alignObjectParams({ position: "nowhere" }).position).toBe("original");
  });

  it("registers through the effect registry with its binding among the built-ins", () => {
    const registry = new EffectRegistry();
    registerBuiltinEffects(registry, 1);
    expect(registry.get(ALIGN_OBJECT_ID)).toEqual(alignObjectDescriptor());
    const ids = builtinEffectBindings(2).map((binding) => binding.descriptor.id);
    expect(ids.at(-5)).toBe(ALIGN_OBJECT_ID);
    expect(ids.at(-6)).toBe("drop-shadow");
  });
});

describe("Align Object scan and notice (FX-OBJ-ALIGN-03, FX-OBJ-ALIGN-06)", () => {
  it("finds the tight box of every pixel with alpha above 0", () => {
    const input = image(10, 8, [
      [3, 2, RED],
      [6, 5, FAINT],
    ]);
    expect(analyzeAlignObject(input)).toEqual({
      width: 10,
      height: 8,
      box: { x1: 3, y1: 2, x2: 7, y2: 6 },
    });
    expect(alignObjectNotice(analyzeAlignObject(input))).toBeUndefined();
  });

  it("reads only selected pixels", () => {
    const input = image(4, 4, [[3, 3, RED]]);
    const coverage = new Uint8Array(16).fill(255);
    coverage[15] = 0;
    expect(analyzeAlignObject(input, coverage).box).toBeNull();
  });

  it("gives the no-object and filled notices", () => {
    expect(alignObjectNotice(analyzeAlignObject(new Surface(3, 3)))).toBe(
      "effect.alignObject.noObject",
    );
    const filled = new Surface(3, 3);
    filled.data.fill(255);
    expect(alignObjectNotice(analyzeAlignObject(filled))).toBe("effect.alignObject.filled");
  });
});

describe("Align Object CPU reference (FX-OBJ-ALIGN-04, FX-OBJ-ALIGN-05)", () => {
  const params = (position: AlignObjectParams["position"], faint = false): AlignObjectParams => ({
    position,
    showFaintPixels: faint,
  });

  it("moves the object to Bottom Right and clears where it was", () => {
    const input = image(6, 5, [
      [1, 1, RED],
      [2, 1, FAINT],
    ]);
    const out = alignObjectCpu(input, params("bottomRight"));
    expect(visible(out)).toEqual([
      [4, 4],
      [5, 4],
    ]);
    expect(pixel(out, 4, 4)).toEqual([...RED]);
    expect(pixel(out, 5, 4)).toEqual([...FAINT]);
    expect(pixel(out, 1, 1)).toEqual([0, 0, 0, 0]);
  });

  it("plans the same offset as the reference, from the scan carried in the parameters", () => {
    const input = image(10, 4, [[7, 0, RED]]);
    const analysis = analyzeAlignObject(input);
    expect(planAlignObject(input, { ...params("centerHorizontally"), analysis })).toEqual({
      box: { x1: 7, y1: 0, x2: 8, y2: 1 },
      dx: -2,
      dy: 0,
      faint: false,
    });
    expect(planAlignObject(new Surface(4, 4), params("center"))).toBeNull();
  });

  it("draws moved pixels opaque with Show faint pixels", () => {
    const input = image(5, 5, [[2, 2, FAINT]]);
    expect(pixel(alignObjectCpu(input, params("topLeft", true)), 0, 0)).toEqual([30, 40, 50, 255]);
  });

  it("leaves the image as it is when there is nothing to align", () => {
    const empty = image(4, 4, []);
    expect([...alignObjectCpu(empty, params("topLeft")).data]).toEqual([...empty.data]);
  });
});

function memoryStore(): EffectValueStore & { readonly values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get: (id) => values.get(id),
    set: (id, _category, stored) => values.set(id, stored),
  };
}

const SIZE = 12;

/** A transparent document layer with a 2 x 2 object at (5, 6), one pixel of it faint. */
function setup(fill?: readonly number[]): { doc: Document; layer: Layer } {
  const doc = Document.createBlank({ width: SIZE, height: SIZE });
  const layer = doc.activeLayer;
  if (layer === undefined) throw new Error("The new document has no layer.");
  const pixels = image(SIZE, SIZE, [
    [5, 6, RED],
    [6, 6, RED],
    [5, 7, RED],
    [6, 7, FAINT],
  ]);
  if (fill !== undefined) {
    for (let i = 0; i < SIZE * SIZE; i++) pixels.data.set(fill, i * 4);
  }
  layer.pixels.writeRegion(pixels, 0, 0);
  return { doc, layer };
}

function readLayer(layer: Layer): Surface {
  return layer.pixels.readRegion(rect(0, 0, SIZE, SIZE));
}

function sessionOptions(
  doc: Document,
  layer: Layer,
  memory: EffectMemory,
): EffectSessionOptions<unknown> {
  return {
    document: doc,
    layer,
    binding: alignObjectBinding(),
    memory,
    historyName: "Align Object",
    backend: "cpu",
    log: () => undefined,
    yieldToHost: async () => undefined,
  };
}

describe("Align Object in an effect session (FX-OBJ-ALIGN-06, -07, -08, -10)", () => {
  const values = (position: string, showFaintPixels = false): PropertyValues => ({
    position,
    showFaintPixels,
  });

  it("previews and commits one Align Object history step", async () => {
    const { doc, layer } = setup();
    const memory = new EffectMemory(memoryStore());
    const session = new EffectSession(sessionOptions(doc, layer, memory));
    expect(session.notice).toBeUndefined();
    await session.preview(values("topLeft"));
    expect(pixel(readLayer(layer), 0, 0)).toEqual([...RED]);
    expect(doc.history.undoName).toBeUndefined();
    await session.ok(values("topLeft"));
    expect(doc.history.undoName).toBe("Align Object");
    const out = readLayer(layer);
    expect(visible(out)).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]);
    expect(pixel(out, 1, 1)).toEqual([...FAINT]);
    // The dialog opens at Original Position again, while Repeat keeps the confirmed position.
    expect(memory.valuesFor(alignObjectDescriptor()).position).toBe("original");
    expect(memory.last?.values.position).toBe("topLeft");
  });

  it("changes nothing at the default Original Position until a position is chosen", async () => {
    const { doc, layer } = setup();
    const before = readLayer(layer);
    const session = new EffectSession(sessionOptions(doc, layer, new EffectMemory(memoryStore())));
    await session.preview(defaultValues(alignObjectSchema()));
    expect([...readLayer(layer).data]).toEqual([...before.data]);
    await session.preview(values("topLeft"));
    expect(pixel(readLayer(layer), 0, 0)).toEqual([...RED]);
    // Back to the default (the dialog's Reset): the preview is undone.
    await session.preview(defaultValues(alignObjectSchema()));
    expect([...readLayer(layer).data]).toEqual([...before.data]);
    await session.ok(defaultValues(alignObjectSchema()));
    expect(doc.history.undoName).toBeUndefined();
    expect(doc.dirty).toBe(false);
  });

  it("changes nothing at the default Original Position until a position is chosen", async () => {
    const { doc, layer } = setup();
    const before = readLayer(layer);
    const session = new EffectSession(sessionOptions(doc, layer, new EffectMemory(memoryStore())));
    await session.preview(defaultValues(alignObjectSchema()));
    expect([...readLayer(layer).data]).toEqual([...before.data]);
    await session.preview(values("topLeft"));
    expect(pixel(readLayer(layer), 0, 0)).toEqual([...RED]);
    // Back to the default (the dialog's Reset): the preview is undone.
    await session.preview(defaultValues(alignObjectSchema()));
    expect([...readLayer(layer).data]).toEqual([...before.data]);
    await session.ok(defaultValues(alignObjectSchema()));
    expect(doc.history.undoName).toBeUndefined();
    expect(doc.dirty).toBe(false);
  });

  it("shows faint pixels opaque in the preview only, and never remembers the option", async () => {
    const { doc, layer } = setup();
    const store = memoryStore();
    const memory = new EffectMemory(store);
    const session = new EffectSession(sessionOptions(doc, layer, memory));
    await session.preview(values("original", true));
    expect(pixel(readLayer(layer), 6, 7)).toEqual([30, 40, 50, 255]);
    await session.ok(values("original", true));
    expect(pixel(readLayer(layer), 6, 7)).toEqual([...FAINT]);
    expect(memory.valuesFor(alignObjectDescriptor()).showFaintPixels).toBe(false);
    expect(memory.last?.values.showFaintPixels).toBe(false);
    expect(memory.last?.values.position).toBe("original");
  });

  it("Repeat runs the stored position without the faint view and scans the layer again", async () => {
    const { doc, layer } = setup();
    const memory = new EffectMemory(memoryStore());
    await new EffectSession(sessionOptions(doc, layer, memory)).ok(values("bottomRight", true));
    const last = memory.last;
    if (last === undefined) throw new Error("no Repeat target");
    // The layer changed since the first run: Repeat aligns what is there now.
    layer.pixels.writeRegion(image(SIZE, SIZE, [[3, 3, RED]]), 0, 0);
    await new EffectSession(sessionOptions(doc, layer, memory)).ok(last.values);
    expect(visible(readLayer(layer))).toEqual([[11, 11]]);
    expect(pixel(readLayer(layer), 11, 11)).toEqual([...RED]);
  });

  it("records no history step and shows the notice when there is no object", async () => {
    const { doc, layer } = setup([0, 0, 0, 0]);
    const session = new EffectSession(sessionOptions(doc, layer, new EffectMemory(memoryStore())));
    expect(session.notice).toBe("effect.alignObject.noObject");
    await session.ok(values("topLeft"));
    expect(session.phase).toBe("committed");
    expect(doc.history.undoName).toBeUndefined();
  });

  it("records no history step and shows the notice when the layer is filled", async () => {
    const { doc, layer } = setup([1, 2, 3, 255]);
    const before = readLayer(layer);
    const session = new EffectSession(sessionOptions(doc, layer, new EffectMemory(memoryStore())));
    expect(session.notice).toBe("effect.alignObject.filled");
    await session.preview(values("topLeft", true));
    expect([...readLayer(layer).data]).toEqual([...before.data]);
    await session.ok(values("topLeft"));
    expect(doc.history.undoName).toBeUndefined();
    expect(doc.dirty).toBe(false);
  });

  it("aligns within the selection's bounds and leaves the pixels outside it", async () => {
    const { doc, layer } = setup();
    // An L-shaped selection: x 4..10 on rows 4..6, and x 4..6 on rows 6..10.
    doc.combineSelection([rectPolygon(rect(4, 4, 6, 2)), rectPolygon(rect(4, 6, 2, 4))], "replace");
    // A pixel outside the selection but inside its bounds, which must be kept.
    layer.pixels.writeRegion(image(1, 1, [[0, 0, [9, 9, 9, 255]]]), 8, 8);
    const session = new EffectSession(sessionOptions(doc, layer, new EffectMemory(memoryStore())));
    expect(session.region).toEqual(rect(4, 4, 6, 6));
    // The selected object is (5, 6) and (5, 7); (6, 6) and (6, 7) are outside the L.
    await session.ok(values("topRight"));
    const out = readLayer(layer);
    // Top Right puts the 1 x 2 object at x 9, rows 4..6: (9, 4) is selected, (9, 5) too.
    expect(pixel(out, 9, 4)).toEqual([...RED]);
    expect(pixel(out, 9, 5)).toEqual([...RED]);
    expect(pixel(out, 5, 6)).toEqual([0, 0, 0, 0]);
    expect(pixel(out, 5, 7)).toEqual([0, 0, 0, 0]);
    expect(pixel(out, 6, 6)).toEqual([...RED]);
    expect(pixel(out, 6, 7)).toEqual([...FAINT]);
    expect(pixel(out, 8, 8)).toEqual([9, 9, 9, 255]);
    expect(doc.history.undoName).toBe("Align Object");
  });

  it("clips moved pixels that land outside a non-rectangular selection", async () => {
    const { doc, layer } = setup();
    doc.combineSelection([rectPolygon(rect(4, 4, 6, 2)), rectPolygon(rect(4, 6, 2, 4))], "replace");
    // Bottom Right puts the object at x 9, rows 8..10, which is outside the L: it is lost.
    await new EffectSession(sessionOptions(doc, layer, new EffectMemory(memoryStore()))).ok(
      values("bottomRight"),
    );
    const out = readLayer(layer);
    expect(pixel(out, 9, 8)).toEqual([0, 0, 0, 0]);
    expect(pixel(out, 9, 9)).toEqual([0, 0, 0, 0]);
    expect(pixel(out, 5, 6)).toEqual([0, 0, 0, 0]);
    expect(pixel(out, 6, 6)).toEqual([...RED]);
  });
});
