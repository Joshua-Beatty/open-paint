/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document, type Layer, type Rect, rect, rectPolygon, Surface } from "@openpaint/document";
import { type EffectDescriptor, EffectRegistry } from "@openpaint/extension-api";
import type { PropertyValues } from "@openpaint/properties";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  builtinEffectBindings,
  GAUSSIAN_BLUR_ID,
  gaussianBlurCpu,
  gaussianBlurParams,
  hueSaturationBinding,
  hueSaturationCpu,
  hueSaturationParams,
  radialBlurBinding,
  registerBuiltinEffects,
} from "../index";
import type { EffectBinding } from "./binding";
import { EffectError } from "./errors";
import type { GpuOffloader } from "./gpu-offload";
import { EffectMemory, type EffectValueStore } from "./memory";
import { EffectSession, type EffectSessionOptions } from "./session";

/** Runs with no dialog: the path Repeat and non-configurable effects take. */
function runNow(options: EffectSessionOptions<unknown>, values: PropertyValues): Promise<void> {
  return new EffectSession(options).ok(values);
}

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const SIZE = 16;

function pattern(width: number, height: number): Surface {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data.set([(i * 37) % 256, (i * 91) % 256, (i * 17) % 256, 255], i * 4);
  }
  return new Surface(width, height, data);
}

function setup(): { doc: Document; layer: Layer } {
  const doc = Document.createBlank({ width: SIZE, height: SIZE });
  const layer = doc.activeLayer;
  if (layer === undefined) throw new Error("The new document has no layer.");
  layer.pixels.writeRegion(pattern(SIZE, SIZE), 0, 0);
  return { doc, layer };
}

function memoryStore(): EffectValueStore & { readonly values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get: (id) => values.get(id),
    set: (id, _category, stored) => values.set(id, stored),
  };
}

function blurBinding(): EffectBinding<unknown> {
  return builtinEffectBindings(2)[0] as EffectBinding<unknown>;
}

function invert(input: Surface): Surface {
  const data = new Uint8ClampedArray(input.data);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255 - (data[i] ?? 0);
    data[i + 1] = 255 - (data[i + 1] ?? 0);
    data[i + 2] = 255 - (data[i + 2] ?? 0);
  }
  return new Surface(input.width, input.height, data);
}

function readOf(layer: Layer, area: Rect = rect(0, 0, SIZE, SIZE)): Surface {
  return layer.pixels.readRegion(area);
}

function options(
  doc: Document,
  layer: Layer,
  binding: EffectBinding<unknown>,
  memory: EffectMemory,
  overrides: Partial<EffectSessionOptions<unknown>> = {},
): EffectSessionOptions<unknown> {
  return {
    document: doc,
    layer,
    binding,
    memory,
    historyName: "Gaussian Blur",
    backend: "cpu",
    log: () => undefined,
    yieldToHost: async () => undefined,
    ...overrides,
  };
}

function blurValues(radius: number): PropertyValues {
  return { radius, gammaBoost: 0, quality: 4 };
}

describe("EffectSession instance seed (FX-A-00-05)", () => {
  it("passes the given instance seed to the binding, or draws one when none is given", async () => {
    const seen: (number | undefined)[] = [];
    const base = blurBinding();
    const binding: EffectBinding<unknown> = {
      descriptor: base.descriptor,
      params: (values, _document, instanceSeed) => {
        seen.push(instanceSeed);
        return base.params(values);
      },
      cpu: base.cpu,
    };
    const { doc, layer } = setup();
    const memory = new EffectMemory(memoryStore());
    await new EffectSession(options(doc, layer, binding, memory, { instanceSeed: 42 })).preview(
      blurValues(2),
    );
    await new EffectSession(options(doc, layer, binding, memory)).preview(blurValues(2));
    expect(seen[0]).toBe(42);
    expect(seen[1]).toEqual(expect.any(Number));
    expect(seen[1]).toBeGreaterThanOrEqual(0);
  });
});

describe("EffectSession live filters (FX-FW-PREVIEW-01)", () => {
  const values = (saturation: number) => ({ hue: 30, saturation, lightness: 0 });

  function liveSession(doc: Document, layer: Layer, shown: number[] = []) {
    return new EffectSession(
      options(
        doc,
        layer,
        hueSaturationBinding() as EffectBinding<unknown>,
        new EffectMemory(memoryStore()),
        {
          historyName: "Hue / Saturation",
          liveFilters: true,
          onPreviewShown: (at) => shown.push(at),
        },
      ),
    );
  }

  it("previews a per-pixel adjustment as the layer's live filter, without writing the layer", async () => {
    const { doc, layer } = setup();
    doc.combineSelection([rectPolygon(rect(0, 0, 8, SIZE))], "replace");
    const original = readOf(layer);
    const changes: string[] = [];
    doc.subscribe((change) => changes.push(change));
    const shown: number[] = [];
    const session = liveSession(doc, layer, shown);
    await session.preview(values(20), 5);
    expect(session.phase).toBe("ready");
    expect(layer.livePreview).toMatchObject({
      effectId: "hueSaturation",
      params: hueSaturationParams(values(20)),
      region: rect(0, 0, 8, SIZE),
    });
    expect(layer.livePreview?.coverage?.length).toBe(8 * SIZE);
    expect(changes).toEqual(["preview"]);
    expect(shown).toEqual([5]);
    expect([...readOf(layer).data]).toEqual([...original.data]);
  });

  it("OK writes the output and takes the filter down in the same notification", async () => {
    const { doc, layer } = setup();
    const original = readOf(layer);
    const expected = hueSaturationCpu(original, hueSaturationParams(values(0)));
    const session = liveSession(doc, layer);
    await session.preview(values(50));
    const seen: { live: boolean; pixels: number[] }[] = [];
    doc.subscribe(() =>
      seen.push({ live: layer.livePreview !== undefined, pixels: [...readOf(layer).data] }),
    );
    await session.ok(values(0));
    expect(session.phase).toBe("committed");
    expect(layer.livePreview).toBeUndefined();
    expect([...readOf(layer).data]).toEqual([...expected.data]);
    // The canvas never sees the filter over the output, nor the original without the filter.
    for (const { live, pixels } of seen) {
      if (live) expect(pixels).toEqual([...original.data]);
      else expect(pixels).toEqual([...expected.data]);
    }
    expect(doc.history.undoName).toBe("Hue / Saturation");
    expect(await doc.history.undo()).toBe(true);
    expect([...readOf(layer).data]).toEqual([...original.data]);
  });

  it("Cancel takes the filter down and leaves the layer alone", async () => {
    const { doc, layer } = setup();
    const original = readOf(layer);
    const session = liveSession(doc, layer);
    await session.preview(values(0));
    let writes = 0;
    const write = layer.pixels.writeRegion.bind(layer.pixels);
    layer.pixels.writeRegion = (...args) => {
      writes += 1;
      return write(...args);
    };
    await session.cancel();
    expect(layer.livePreview).toBeUndefined();
    expect(writes).toBe(0);
    expect([...readOf(layer).data]).toEqual([...original.data]);
    expect(doc.history.undoName).toBeUndefined();
  });

  it("still writes the previews of an effect that is not per pixel", async () => {
    const { doc, layer } = setup();
    const original = readOf(layer);
    const session = new EffectSession(
      options(doc, layer, blurBinding(), new EffectMemory(memoryStore()), { liveFilters: true }),
    );
    await session.preview(blurValues(6));
    expect(layer.livePreview).toBeUndefined();
    expect([...readOf(layer).data]).not.toEqual([...original.data]);
  });
});

describe("EffectSession with Gaussian Blur", () => {
  it("resolves the effect through the registry and runs it on the layer", () => {
    const registry = new EffectRegistry();
    registerBuiltinEffects(registry, 2);
    const descriptor = registry.get(GAUSSIAN_BLUR_ID);
    expect(descriptor).toBeDefined();
    expect(blurBinding().descriptor).toEqual(descriptor);
  });

  it("previews into the layer, then OK records one history item that undo and redo replay", async () => {
    const { doc, layer } = setup();
    const memory = new EffectMemory(memoryStore());
    const binding = blurBinding();
    const values = blurValues(6);
    const original = readOf(layer);
    const expected = gaussianBlurCpu(original, gaussianBlurParams(values, 2));
    const session = new EffectSession(options(doc, layer, binding, memory));
    await session.preview(values);
    expect(session.phase).toBe("ready");
    expect([...readOf(layer).data]).toEqual([...expected.data]);
    expect(doc.history.undoName).toBeUndefined();

    await session.ok(values);
    expect(session.phase).toBe("committed");
    expect(doc.history.undoName).toBe("Gaussian Blur");
    expect(doc.history.entries.length).toBe(2);

    expect(await doc.history.undo()).toBe(true);
    expect([...readOf(layer).data]).toEqual([...original.data]);
    expect(await doc.history.redo()).toBe(true);
    expect([...readOf(layer).data]).toEqual([...expected.data]);
  });

  it("Cancel restores the original pixels and records nothing or remembers nothing", async () => {
    const { doc, layer } = setup();
    const store = memoryStore();
    const memory = new EffectMemory(store);
    const original = readOf(layer);
    const session = new EffectSession(options(doc, layer, blurBinding(), memory));
    await session.preview(blurValues(8));
    expect([...readOf(layer).data]).not.toEqual([...original.data]);

    await session.cancel();
    expect([...readOf(layer).data]).toEqual([...original.data]);
    expect(doc.history.undoName).toBeUndefined();
    expect(doc.dirty).toBe(false);
    expect(store.values.size).toBe(0);
    expect(memory.last).toBeUndefined();
    await expect(session.ok(blurValues(8))).rejects.toThrow("already canceled");
  });

  it("notifies the document as preview tiles land and when Cancel restores the layer", async () => {
    const { doc, layer } = setup();
    const memory = new EffectMemory(memoryStore());
    const original = readOf(layer);
    const notified: number[][] = [];
    // Each notification records the first pixel the listener sees, as the engine would read it.
    doc.subscribe(() => notified.push([...readOf(layer, rect(0, 0, 1, 1)).data]));
    const session = new EffectSession(options(doc, layer, blurBinding(), memory));
    await session.preview(blurValues(8));
    const blurred = [...readOf(layer, rect(0, 0, 1, 1)).data];
    expect(notified).toEqual([blurred]);
    expect(blurred).not.toEqual([...original.data.slice(0, 4)]);

    await session.cancel();
    expect(notified.at(-1)).toEqual([...original.data.slice(0, 4)]);
    expect(doc.history.undoName).toBeUndefined();
  });

  it("a newer preview cancels the render in flight and shows the latest values", async () => {
    const { doc, layer } = setup();
    const memory = new EffectMemory(memoryStore());
    const original = readOf(layer);
    const session = new EffectSession(options(doc, layer, blurBinding(), memory));
    const first = session.preview(blurValues(3));
    const second = session.preview(blurValues(9));
    await Promise.all([first, second]);
    const expected = gaussianBlurCpu(original, gaussianBlurParams(blurValues(9), 2));
    expect([...readOf(layer).data]).toEqual([...expected.data]);
  });

  it("limits the effect to the selection and keeps the pixels outside it", async () => {
    const { doc, layer } = setup();
    doc.combineSelection([rectPolygon(rect(0, 0, 8, SIZE))], "replace");
    const memory = new EffectMemory(memoryStore());
    const original = readOf(layer);
    const values = blurValues(4);
    const leftOriginal = readOf(layer, rect(0, 0, 8, SIZE));
    const expectedLeft = gaussianBlurCpu(leftOriginal, gaussianBlurParams(values, 2));
    const session = new EffectSession(options(doc, layer, blurBinding(), memory));
    await session.ok(values);
    expect(session.region).toEqual(rect(0, 0, 8, SIZE));
    expect([...readOf(layer, rect(0, 0, 8, SIZE)).data]).toEqual([...expectedLeft.data]);
    const after = readOf(layer);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 8; x < SIZE; x++) {
        const i = (y * SIZE + x) * 4;
        expect([...after.data.slice(i, i + 4)]).toEqual([...original.data.slice(i, i + 4)]);
      }
    }
  });

  it("keeps the whole layer as it was at open for a dialog with a layer pan control", () => {
    const { doc, layer } = setup();
    doc.combineSelection([rectPolygon(rect(0, 0, 8, SIZE))], "replace");
    const original = readOf(layer);
    const session = new EffectSession(
      options(doc, layer, radialBlurBinding(1), new EffectMemory(memoryStore())),
    );
    const source = session.source;
    expect(source?.pixels.width).toBe(8);
    expect([...(source?.layer?.data ?? [])]).toEqual([...original.data]);
  });

  it("takes no layer snapshot for a dialog without a layer pan control", () => {
    const { doc, layer } = setup();
    const session = new EffectSession(
      options(doc, layer, blurBinding(), new EffectMemory(memoryStore())),
    );
    expect(session.source?.layer).toBeUndefined();
  });

  it("restores the layer and throws EffectError when the effect fails, without a history item", async () => {
    const { doc, layer } = setup();
    const original = readOf(layer);
    const failing: EffectBinding<unknown> = {
      ...blurBinding(),
      cpu: () => {
        throw new Error("broken");
      },
    };
    const logged: string[] = [];
    const session = new EffectSession(
      options(doc, layer, failing, new EffectMemory(memoryStore()), {
        log: (message) => logged.push(message),
      }),
    );
    const error = await session.ok(blurValues(2)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EffectError);
    expect((error as EffectError).effectId).toBe(GAUSSIAN_BLUR_ID);
    expect(session.phase).toBe("failed");
    expect(logged).toHaveLength(1);
    expect([...readOf(layer).data]).toEqual([...original.data]);
    expect(doc.history.undoName).toBeUndefined();
  });

  it("remembers the values on OK and makes the effect the Repeat target", async () => {
    const { doc, layer } = setup();
    const store = memoryStore();
    const memory = new EffectMemory(store);
    const binding = blurBinding();
    await runNow(options(doc, layer, binding, memory), blurValues(5));
    expect(memory.valuesFor(binding.descriptor).radius).toBe(5);
    expect(memory.last?.effectId).toBe(GAUSSIAN_BLUR_ID);
    expect(memory.last?.values.radius).toBe(5);
    expect(store.values.has(GAUSSIAN_BLUR_ID)).toBe(true);
  });

  it("never makes an adjustment the Repeat target", async () => {
    const { doc, layer } = setup();
    const memory = new EffectMemory(memoryStore());
    const base = blurBinding();
    const adjustment: EffectBinding<unknown> = {
      ...base,
      descriptor: { ...base.descriptor, id: "soft-adjust", category: "adjustment" },
      cpu: (input) => invert(input),
    };
    await runNow(options(doc, layer, adjustment, memory), blurValues(1));
    expect(memory.last).toBeUndefined();
    expect(doc.history.undoName).toBe("Gaussian Blur");
  });

  it("runs a non-configurable effect with one history item and no remembered values", async () => {
    const { doc, layer } = setup();
    const original = readOf(layer);
    const store = memoryStore();
    const base = blurBinding();
    const plain: EffectBinding<unknown> = {
      descriptor: {
        ...base.descriptor,
        id: "invert-colors",
        configurable: false,
      } as EffectDescriptor,
      params: () => undefined,
      cpu: (input) => invert(input),
    };
    await runNow(
      options(doc, layer, plain, new EffectMemory(store), { historyName: "Invert" }),
      {},
    );
    expect([...readOf(layer).data.slice(0, 4)]).toEqual([...invert(original).data.slice(0, 4)]);
    expect(doc.history.undoName).toBe("Invert");
    expect(store.values.size).toBe(0);
  });

  it("Reset restores the declared default, not the remembered value", () => {
    const store = memoryStore();
    const memory = new EffectMemory(store);
    const descriptor = blurBinding().descriptor;
    memory.remember(descriptor, blurValues(7));
    expect(memory.valuesFor(descriptor).radius).toBe(7);
    expect(memory.defaultsFor(descriptor).radius).toBe(2);
  });

  it("opens openAtDefaultProperties at their defaults, while Repeat keeps the confirmed values", () => {
    const memory = new EffectMemory(memoryStore());
    const base = blurBinding().descriptor;
    const descriptor: EffectDescriptor = {
      ...base,
      options: { ...base.options, openAtDefaultProperties: ["radius"] },
    };
    memory.remember(descriptor, blurValues(7));
    memory.recordRun(descriptor, blurValues(7));
    expect(memory.valuesFor(descriptor).radius).toBe(2);
    expect(memory.last?.values.radius).toBe(7);
  });

  it("falls back to the declared defaults when the stored values are invalid", () => {
    const store = memoryStore();
    store.set(GAUSSIAN_BLUR_ID, "effect", { radius: "not a number" } as never);
    const memory = new EffectMemory(store);
    expect(memory.valuesFor(blurBinding().descriptor)).toEqual(
      memory.defaultsFor(blurBinding().descriptor),
    );
  });

  it("refuses further changes once committed", async () => {
    const { doc, layer } = setup();
    const session = new EffectSession(
      options(doc, layer, blurBinding(), new EffectMemory(memoryStore())),
    );
    await session.ok(blurValues(2));
    expect(() => session.preview(blurValues(3))).toThrow("already committed");
  });
});

describe("EffectSession on the GPU offloader (WEB-GPU-01)", () => {
  it("previews and commits through the offloader with one source, then releases it", async () => {
    const { doc, layer } = setup();
    const inputs: Surface[] = [];
    const released: Surface[] = [];
    const gpu: GpuOffloader = {
      canRun: () => true,
      run: async (_binding, input) => {
        inputs.push(input);
        return invert(input);
      },
      release: (input) => released.push(input),
    };
    const session = new EffectSession(
      options(doc, layer, blurBinding(), new EffectMemory(memoryStore()), { backend: "gpu", gpu }),
    );
    await session.preview(blurValues(2));
    await session.preview(blurValues(3));
    await session.ok(blurValues(3));
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toBe(inputs[0]);
    expect(released).toEqual([inputs[0]]);
    expect([...readOf(layer).data]).toEqual([...invert(pattern(SIZE, SIZE)).data]);
    expect(doc.history.undoName).toBe("Gaussian Blur");
  });

  it("releases the source when the session is canceled", async () => {
    const { doc, layer } = setup();
    const released: Surface[] = [];
    const gpu: GpuOffloader = {
      canRun: () => true,
      run: async (_binding, input) => invert(input),
      release: (input) => released.push(input),
    };
    const session = new EffectSession(
      options(doc, layer, blurBinding(), new EffectMemory(memoryStore()), { backend: "gpu", gpu }),
    );
    await session.preview(blurValues(2));
    await session.cancel();
    expect(released).toHaveLength(1);
    expect([...readOf(layer).data]).toEqual([...pattern(SIZE, SIZE).data]);
  });
});

describe("EffectSession GPU previews while a slider is dragged (FX-FW-PREVIEW-01)", () => {
  it("lets the GPU render in flight finish and renders only the newest values after it", async () => {
    const { doc, layer } = setup();
    const radii: number[] = [];
    const finish: (() => void)[] = [];
    const gpu: GpuOffloader = {
      canRun: () => true,
      run: (_binding, input, params) => {
        radii.push((params as { radius: number }).radius);
        return new Promise((resolve) => finish.push(() => resolve(invert(input))));
      },
    };
    const shown: number[] = [];
    const session = new EffectSession(
      options(doc, layer, blurBinding(), new EffectMemory(memoryStore()), {
        backend: "gpu",
        gpu,
        onPreviewShown: (at) => shown.push(at),
      }),
    );
    const first = session.preview(blurValues(1), 1);
    session.preview(blurValues(2), 2);
    const last = session.preview(blurValues(3), 3);
    await vi.waitFor(() => expect(finish).toHaveLength(1));
    finish[0]?.();
    await vi.waitFor(() => expect(finish).toHaveLength(2));
    finish[1]?.();
    await first;
    await last;
    expect(radii).toEqual([1, 3]);
    expect(shown).toEqual([1, 3]);
    expect(session.phase).toBe("ready");
  });
});
