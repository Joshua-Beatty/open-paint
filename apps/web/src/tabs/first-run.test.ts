import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { createFirstRunImage, FIRST_RUN_HEIGHT, FIRST_RUN_WIDTH } from "./first-run";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

describe("createFirstRunImage", () => {
  it("opens a clean blank 800 x 600 image with one white Background layer (SET-LIFE-10)", () => {
    const image = createFirstRunImage("Untitled");
    const { document } = image;
    try {
      expect(image.name).toBe("Untitled");
      expect([FIRST_RUN_WIDTH, FIRST_RUN_HEIGHT]).toEqual([800, 600]);
      expect([document.width, document.height]).toEqual([800, 600]);
      expect(document.layers.map((layer) => layer.name)).toEqual(["Background"]);
      expect(document.dirty).toBe(false);
    } finally {
      document.dispose();
    }
  });
});
