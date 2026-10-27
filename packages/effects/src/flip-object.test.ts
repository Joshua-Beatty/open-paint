/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm, { flip_object_rgba8 } from "@openpaint/cpu";
import {
  Document,
  ellipsePolygon,
  type Layer,
  type Rect,
  rect,
  rectPolygon,
  Selection,
  type SelectionPolygon,
  type SelectionQuality,
  Surface,
} from "@openpaint/document";
import { EffectRegistry, effectMenu } from "@openpaint/extension-api";
import { beforeAll, describe, expect, it } from "vitest";
import {
  EffectMemory,
  EffectSession,
  type EffectValueStore,
  FLIP_HORIZONTAL_ID,
  FLIP_VERTICAL_ID,
  flipHorizontalBinding,
  flipHorizontalDescriptor,
  flipObjectCpu,
  flipSelection,
  flipVerticalBinding,
  flipVerticalDescriptor,
  registerBuiltinEffects,
} from "./index";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const SIZE = 12;

/** A distinct opaque colour per pixel, so any remap shows. */
function pattern(width: number, height: number): Surface {
  const surface = new Surface(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      surface.data.set([x * 20 + 5, y * 20 + 7, (x * 7 + y * 3) % 256, 255], (y * width + x) * 4);
    }
  }
  return surface;
}

function pixel(surface: Surface, x: number, y: number): number[] {
  const i = (y * surface.width + x) * 4;
  return [...surface.data.slice(i, i + 4)];
}

/** `mask` (over `area`) remapped as the pixels are: the mirror of every row or column. */
function mirroredMask(mask: Uint8Array, area: Rect, vertical: boolean): number[] {
  const out: number[] = [];
  for (let y = 0; y < area.height; y++) {
    for (let x = 0; x < area.width; x++) {
      const sx = vertical ? x : area.width - 1 - x;
      const sy = vertical ? area.height - 1 - y : y;
      out.push(mask[sy * area.width + sx] ?? 0);
    }
  }
  return out;
}

/** An L: a 2-wide column at the left and a 2-high foot at the bottom, in (2, 3)-(9, 10). */
const L_SHAPE: SelectionPolygon = [2, 3, 4, 3, 4, 8, 9, 8, 9, 10, 2, 10];

function setup(selection?: Selection): { doc: Document; layer: Layer } {
  const doc = Document.createBlank({ width: SIZE, height: SIZE });
  const layer = doc.activeLayer;
  if (layer === undefined) throw new Error("The new document has no layer.");
  layer.pixels.writeRegion(pattern(SIZE, SIZE), 0, 0);
  if (selection !== undefined) doc.replaceSelection(selection, "Select");
  return { doc, layer };
}

function readLayer(layer: Layer): Surface {
  return layer.pixels.readRegion(rect(0, 0, SIZE, SIZE));
}

function memoryStore(): EffectValueStore {
  const values = new Map<string, unknown>();
  return { get: (id) => values.get(id), set: (id, _category, stored) => values.set(id, stored) };
}

async function flip(doc: Document, layer: Layer, vertical: boolean): Promise<void> {
  const session = new EffectSession({
    document: doc,
    layer,
    binding: vertical ? flipVerticalBinding() : flipHorizontalBinding(),
    memory: new EffectMemory(memoryStore()),
    historyName: vertical ? "Flip Vertical" : "Flip Horizontal",
    backend: "cpu",
    log: () => undefined,
    yieldToHost: async () => undefined,
  });
  await session.ok({});
}

describe("Flip Horizontal and Flip Vertical descriptors (FX-OBJ-FLIP-01)", () => {
  it("are dialog-less GPU effects in the Object submenu that clip the selection themselves", () => {
    for (const [descriptor, id, label] of [
      [flipHorizontalDescriptor(), FLIP_HORIZONTAL_ID, "effect.flipHorizontal"],
      [flipVerticalDescriptor(), FLIP_VERTICAL_ID, "effect.flipVertical"],
    ] as const) {
      expect(descriptor).toMatchObject({
        id,
        label,
        category: "effect",
        submenu: "object",
        configurable: false,
        kind: "gpuImage",
        options: { disableSelectionClipping: true },
      });
      expect(descriptor.schema.properties).toEqual([]);
      expect(descriptor.options?.forceAliasedSelection).toBeUndefined();
    }
  });

  it("are registered, so the Object submenu lists them after Align Object with no ellipsis", () => {
    const registry = new EffectRegistry();
    registerBuiltinEffects(registry, 1);
    const object = effectMenu(registry).submenus.find((submenu) => submenu.name === "object");
    const titles = object?.items.map((item) => item.title) ?? [];
    expect(titles).toContain("Flip Horizontal");
    expect(titles).toContain("Flip Vertical");
    expect(titles.indexOf("Flip Horizontal")).toBeGreaterThan(titles.indexOf("Align Object..."));
    expect(titles.indexOf("Flip Vertical")).toBe(titles.indexOf("Flip Horizontal") + 1);
  });
});

describe("flipObjectCpu (FX-OBJ-FLIP-02, FX-OBJ-FLIP-04)", () => {
  it("mirrors every pixel without a selection, for odd and even sizes", () => {
    for (const [w, h] of [
      [4, 3],
      [5, 4],
    ] as const) {
      const input = pattern(w, h);
      const across = flipObjectCpu(input, { vertical: false });
      const down = flipObjectCpu(input, { vertical: true });
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          expect(pixel(across, x, y)).toEqual(pixel(input, w - 1 - x, y));
          expect(pixel(down, x, y)).toEqual(pixel(input, x, h - 1 - y));
        }
      }
    }
  });

  it("is the Rust reference with the selection's coverage", () => {
    const input = pattern(6, 5);
    const coverage = Uint8Array.from({ length: 30 }, (_, i) => (i * 37) % 256);
    const out = flipObjectCpu(input, { vertical: true }, coverage);
    const reference = flip_object_rgba8(new Uint8Array(input.data.buffer), 6, 5, coverage, true);
    expect([...out.data]).toEqual([...reference]);
  });
});

/** A 6 x 4 rectangle turned by 0.4 radians about (5, 5). */
const ROTATED_SQUARE: SelectionPolygon = [2, 3, 8, 3, 8, 7, 2, 7].map((value, i, all) => {
  const t = 0.4;
  const x = (i % 2 === 0 ? value : (all[i - 1] ?? 0)) - 5;
  const y = (i % 2 === 0 ? (all[i + 1] ?? 0) : value) - 5;
  return i % 2 === 0
    ? 5 + x * Math.cos(t) - y * Math.sin(t)
    : 5 + x * Math.sin(t) + y * Math.cos(t);
});

describe("flipSelection (FX-OBJ-FLIP-03)", () => {
  it("mirrors a rotated outline exactly, keeping its fractional vertices", () => {
    const selection = new Selection([ROTATED_SQUARE]);
    const region = selection.bounds();
    const flipped = flipSelection(selection, region, false);
    expect(flipped.area()).toBeCloseTo(selection.area(), 6);
    expect(flipped.polygons.flat().some((value) => !Number.isInteger(value))).toBe(true);
  });

  const cases: readonly [string, SelectionPolygon, SelectionQuality][] = [
    ["an aliased L", L_SHAPE, "aliased"],
    ["an antialiased L", L_SHAPE, "antialiased"],
    [
      "an antialiased ellipse",
      ellipsePolygon({ x: 1.3, y: 2.6, width: 7.2, height: 5.1 }),
      "antialiased",
    ],
    ["an aliased ellipse", ellipsePolygon({ x: 1, y: 2, width: 7, height: 5 }), "aliased"],
    // A rotated outline keeps its exact, fractional vertices (owner request).
    ["an antialiased rotated square", ROTATED_SQUARE, "antialiased"],
    ["an aliased rotated square", ROTATED_SQUARE, "aliased"],
  ];
  for (const [name, polygon, quality] of cases) {
    for (const vertical of [false, true]) {
      it(`mirrors ${name} ${vertical ? "top to bottom" : "left to right"} in its bounding box`, () => {
        const selection = new Selection([polygon], quality);
        const region = selection.bounds();
        const flipped = flipSelection(selection, region, vertical);
        expect(flipped.bounds()).toEqual(region);
        expect(flipped.quality).toBe(quality);
        expect([...flipped.mask(region)]).toEqual(
          mirroredMask(selection.mask(region), region, vertical),
        );
      });
    }
  }

  it("keeps a rectangle and an empty selection as they are", () => {
    const box = new Selection([rectPolygon(rect(2, 3, 5, 4))]);
    expect(flipSelection(box, rect(2, 3, 5, 4), false)).toBe(box);
    const none = new Selection();
    expect(flipSelection(none, rect(0, 0, SIZE, SIZE), true)).toBe(none);
  });

  it("drops the part of the selection outside the region before mirroring", () => {
    const selection = new Selection([
      rectPolygon(rect(-4, 0, 8, 2)),
      rectPolygon(rect(0, 4, 2, 2)),
    ]);
    const flipped = flipSelection(selection, rect(0, 0, 4, 6), false);
    expect(flipped.bounds()).toEqual(rect(0, 0, 4, 6));
    expect(flipped.area()).toBe(4 * 2 + 2 * 2);
    expect(flipped.mask(rect(2, 4, 2, 2)).every((c) => c === 255)).toBe(true);
  });
});

describe("Flip in an effect session (FX-OBJ-FLIP-05)", () => {
  it("mirrors the whole layer with no selection, as one history step", async () => {
    const { doc, layer } = setup();
    const before = readLayer(layer);
    await flip(doc, layer, false);
    expect(doc.history.undoName).toBe("Flip Horizontal");
    const after = readLayer(layer);
    expect(pixel(after, 0, 5)).toEqual(pixel(before, SIZE - 1, 5));
    expect(doc.selection.isEmpty).toBe(true);
    await doc.history.undo();
    expect([...readLayer(layer).data]).toEqual([...before.data]);
  });

  it("mirrors a rectangle's pixels about its own centre and leaves the rest", async () => {
    const box = rect(2, 3, 5, 4);
    const selection = new Selection([rectPolygon(box)]);
    const { doc, layer } = setup(selection);
    const before = readLayer(layer);
    await flip(doc, layer, true);
    const after = readLayer(layer);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const inside = x >= 2 && x < 7 && y >= 3 && y < 7;
        expect(pixel(after, x, y)).toEqual(inside ? pixel(before, x, 9 - y) : pixel(before, x, y));
      }
    }
    expect(doc.selection).toBe(selection);
  });

  it("moves an L's pixels and outline together; undo restores both, redo repeats both", async () => {
    const selection = new Selection([L_SHAPE], "aliased");
    const { doc, layer } = setup(selection);
    const before = readLayer(layer);
    await flip(doc, layer, false);
    expect(doc.history.undoName).toBe("Flip Horizontal");
    const after = readLayer(layer);
    const flipped = doc.selection;
    expect(flipped).not.toBe(selection);
    const region = rect(2, 3, 7, 7);
    const old = selection.mask(region);
    const now = flipped.mask(region);
    expect([...now]).toEqual(mirroredMask(old, region, false));
    for (let y = 0; y < region.height; y++) {
      for (let x = 0; x < region.width; x++) {
        const i = y * region.width + x;
        const [dx, dy] = [region.x + x, region.y + y];
        const expected =
          now[i] === 255
            ? pixel(before, region.x + region.width - 1 - x, dy)
            : old[i] === 255
              ? [0, 0, 0, 0]
              : pixel(before, dx, dy);
        expect(pixel(after, dx, dy), `(${dx}, ${dy})`).toEqual(expected);
      }
    }
    // The L's column at the left is vacated; its foot now ends at the right.
    expect(pixel(after, 2, 3)).toEqual([0, 0, 0, 0]);
    expect(pixel(after, 8, 3)).toEqual(pixel(before, 2, 3));
    // Outside the bounding box nothing changed.
    expect(pixel(after, 0, 0)).toEqual(pixel(before, 0, 0));
    expect(pixel(after, 10, 11)).toEqual(pixel(before, 10, 11));

    await doc.history.undo();
    expect([...readLayer(layer).data]).toEqual([...before.data]);
    expect(doc.selection).toBe(selection);
    await doc.history.redo();
    expect([...readLayer(layer).data]).toEqual([...after.data]);
    expect(doc.selection).toBe(flipped);
  });

  it("flipping an ellipse twice restores its outline and its fully selected pixels", async () => {
    const selection = new Selection([ellipsePolygon({ x: 1, y: 2, width: 6, height: 7 })]);
    const { doc, layer } = setup(selection);
    const before = readLayer(layer);
    await flip(doc, layer, true);
    await flip(doc, layer, true);
    const region = selection.bounds();
    expect([...doc.selection.mask(region)]).toEqual([...selection.mask(region)]);
    const mask = selection.mask(region);
    const after = readLayer(layer);
    for (let y = 0; y < region.height; y++) {
      for (let x = 0; x < region.width; x++) {
        const [dx, dy] = [region.x + x, region.y + y];
        if (mask[y * region.width + x] === 255) {
          expect(pixel(after, dx, dy)).toEqual(pixel(before, dx, dy));
        }
      }
    }
  });
});
