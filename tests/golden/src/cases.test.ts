import { readFile } from "node:fs/promises";
import { RESAMPLE_FILTERS } from "@openpaint/document";
import { LAYER_BLEND_MODE_COUNT } from "@openpaint/engine";
import { describe, expect, it } from "vitest";
import {
  BLEND_CASES,
  BLEND_INPUTS,
  BLEND_MODE_NAMES,
  BLEND_OPACITIES,
  RESAMPLE_CASES,
  RESAMPLE_FILTER_NAMES,
  RESAMPLE_INPUT,
} from "./cases";

const ROOT = new URL("../", import.meta.url);

describe("resampling golden cases", () => {
  it("cover every DOC-IMG-02 filter in both directions and gamma modes", () => {
    expect(RESAMPLE_FILTER_NAMES).toEqual(RESAMPLE_FILTERS);
    expect(RESAMPLE_CASES).toHaveLength(RESAMPLE_FILTER_NAMES.length * 2 * 2);
    expect(new Set(RESAMPLE_CASES.map((c) => c.id)).size).toBe(RESAMPLE_CASES.length);
    expect(new Set(RESAMPLE_CASES.map((c) => c.expected)).size).toBe(RESAMPLE_CASES.length);
  });

  it("points at reference files that exist", async () => {
    for (const path of [RESAMPLE_INPUT, ...RESAMPLE_CASES.map((c) => c.expected)]) {
      await expect(readFile(new URL(path, ROOT))).resolves.toBeInstanceOf(Buffer);
    }
  });
});

describe("golden cases", () => {
  it("cover all 14 layer blend modes in DOC-BLD-01 order", () => {
    expect(BLEND_MODE_NAMES).toEqual([
      "normal",
      "multiply",
      "additive",
      "color-burn",
      "color-dodge",
      "reflect",
      "glow",
      "overlay",
      "difference",
      "negation",
      "lighten",
      "darken",
      "screen",
      "xor",
    ]);
    expect(BLEND_MODE_NAMES).toHaveLength(LAYER_BLEND_MODE_COUNT);
    expect(new Set(BLEND_CASES.map((c) => c.mode))).toEqual(
      new Set(Array.from({ length: LAYER_BLEND_MODE_COUNT }, (_, mode) => mode)),
    );
  });

  it("runs every mode at each opacity", () => {
    expect(BLEND_CASES).toHaveLength(LAYER_BLEND_MODE_COUNT * BLEND_OPACITIES.length);
    for (const opacity of BLEND_OPACITIES) {
      const modes = BLEND_CASES.filter((c) => c.opacity === opacity).map((c) => c.mode);
      expect(modes).toHaveLength(LAYER_BLEND_MODE_COUNT);
    }
  });

  it("gives every case a unique id and reference path", () => {
    expect(new Set(BLEND_CASES.map((c) => c.id)).size).toBe(BLEND_CASES.length);
    expect(new Set(BLEND_CASES.map((c) => c.expected)).size).toBe(BLEND_CASES.length);
  });

  it("points at reference files that exist", async () => {
    for (const path of [
      BLEND_INPUTS.dst,
      BLEND_INPUTS.src,
      ...BLEND_CASES.map((c) => c.expected),
    ]) {
      await expect(readFile(new URL(path, ROOT))).resolves.toBeInstanceOf(Buffer);
    }
  });
});
