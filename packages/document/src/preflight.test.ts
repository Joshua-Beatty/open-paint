/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { Document } from "./document";
import {
  DEFAULT_MEMORY_BUDGET_BYTES,
  MemoryAccountant,
  memoryBudgetForDeviceMemory,
  OutOfMemoryError,
} from "./memory";
import { TiledPixelStore } from "./tiled-store";

/** WEB-MEM-03: the byte cost of one 256 px tile, which every store allocates in whole tiles. */
const TILE = TiledPixelStore.estimateBytes(256, 256);
const NEAREST = { filter: "nearest", linearLight: false } as const;

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

function failureOf(action: () => unknown): OutOfMemoryError {
  try {
    action();
  } catch (error) {
    if (error instanceof OutOfMemoryError) return error;
    throw error;
  }
  throw new Error("Expected an out-of-memory error.");
}

describe("pre-flight budget checks (WEB-MEM-03)", () => {
  it("refuses a new image before allocating anything, and names the operation", () => {
    const accountant = new MemoryAccountant(TILE);
    const error = failureOf(() => Document.createBlank({ width: 512, height: 512, accountant }));

    expect(error.operation).toBe("newImage");
    expect(error.requestedBytes).toBe(4 * TILE);
    expect(error.availableBytes).toBe(TILE);
    expect(accountant.usedBytes).toBe(0);
  });

  it("refuses a resize before any layer is resampled, leaving the image unchanged", () => {
    const accountant = new MemoryAccountant(TILE);
    const doc = Document.createBlank({ width: 4, height: 4, accountant });

    const error = failureOf(() => doc.resize({ width: 512, height: 512 }, NEAREST));

    expect(error.operation).toBe("resize");
    expect(doc.width).toBe(4);
    expect(doc.height).toBe(4);
    expect(doc.history.canUndo).toBe(false);
    expect(accountant.usedBytes).toBe(TILE);
  });

  it("counts every layer in the resize estimate", () => {
    const accountant = new MemoryAccountant(2 * TILE);
    const doc = Document.createBlank({ width: 4, height: 4, accountant });
    doc.addLayer();

    const error = failureOf(() => doc.resize({ width: 256, height: 256 }, NEAREST));

    expect(error.operation).toBe("resize");
    expect(error.requestedBytes).toBe(2 * TILE);
  });

  it("refuses a canvas size change with its own operation", () => {
    const accountant = new MemoryAccountant(TILE);
    const doc = Document.createBlank({ width: 4, height: 4, accountant });
    const transparent = { r: 0, g: 0, b: 0, a: 0 };

    const error = failureOf(() =>
      doc.resizeCanvas({ width: 512, height: 4 }, "topLeft", transparent),
    );

    expect(error.operation).toBe("canvasSize");
    expect(doc.width).toBe(4);
  });

  it("does not check a resize that only changes the resolution", () => {
    const accountant = new MemoryAccountant(TILE);
    const doc = Document.createBlank({ width: 4, height: 4, accountant });

    const resolution = { unit: "inch", x: 300, y: 300 } as const;

    expect(doc.resize({ width: 4, height: 4 }, NEAREST, resolution)).toBe(true);
    expect(accountant.usedBytes).toBe(TILE);
  });
});

describe("memory budget heuristic (WEB-MEM-03)", () => {
  it("uses the 2 GiB default without a device memory report", () => {
    expect(memoryBudgetForDeviceMemory(undefined)).toBe(DEFAULT_MEMORY_BUDGET_BYTES);
    expect(memoryBudgetForDeviceMemory(0)).toBe(DEFAULT_MEMORY_BUDGET_BYTES);
  });

  it("gives a quarter of the device memory, capped at the default", () => {
    expect(memoryBudgetForDeviceMemory(8)).toBe(DEFAULT_MEMORY_BUDGET_BYTES);
    expect(memoryBudgetForDeviceMemory(4)).toBe(1024 ** 3);
    expect(memoryBudgetForDeviceMemory(2)).toBe(512 * 1024 ** 2);
  });

  it("never goes below 256 MiB", () => {
    expect(memoryBudgetForDeviceMemory(0.25)).toBe(256 * 1024 ** 2);
  });
});
