/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { rotationAboutAffine, scalingAboutAffine, translationAffine } from "./affine";
import { rgba8 } from "./color";
import { rect } from "./geometry";
import { renderTransformed } from "./pixel-transform";
import { Surface } from "./surface";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const OPTIONS = { sampling: "cubic", linearLight: true } as const;
const RED = rgba8(255, 0, 0);
const CANVAS = rect(0, 0, 8, 8);

/** A 2 x 2 image: red on the left, green on the right. */
function stripe(): Surface {
  const surface = new Surface(2, 2);
  surface.fill(rgba8(0, 255, 0));
  surface.fill(RED, rect(0, 0, 1, 2));
  return surface;
}

describe("renderTransformed", () => {
  it("moves whole-pixel translations exactly, for every sampling", () => {
    for (const sampling of ["nearest", "linear", "multisample", "anisotropic", "cubic"] as const) {
      const out = renderTransformed(
        stripe(),
        translationAffine(3, 4),
        { sampling, linearLight: true },
        CANVAS,
      );
      expect(out?.origin).toEqual({ x: 3, y: 4 });
      expect(out?.pixels.getPixel(0, 0)).toEqual(RED);
      expect(out?.pixels.getPixel(1, 1)).toEqual(rgba8(0, 255, 0));
    }
  });

  it("clips a translation to the clip rectangle", () => {
    const out = renderTransformed(stripe(), translationAffine(7, 0), OPTIONS, CANVAS);
    expect(out?.origin).toEqual({ x: 7, y: 0 });
    expect(out?.pixels.width).toBe(1);
    expect(out?.pixels.getPixel(0, 0)).toEqual(RED);
  });

  it("returns nothing when the content lands outside the clip rectangle", () => {
    expect(renderTransformed(stripe(), translationAffine(20, 0), OPTIONS, CANVAS)).toBeUndefined();
  });

  it("scales up with nearest neighbor into hard blocks", () => {
    const out = renderTransformed(
      stripe(),
      scalingAboutAffine(0, 0, 2, 2),
      { sampling: "nearest", linearLight: false },
      CANVAS,
    );
    expect(out?.pixels.width).toBe(4);
    expect(out?.pixels.getPixel(1, 3)).toEqual(RED);
    expect(out?.pixels.getPixel(2, 0)).toEqual(rgba8(0, 255, 0));
  });

  it("rotates a block and leaves the corners transparent", () => {
    const block = new Surface(4, 4);
    block.fill(RED);
    const out = renderTransformed(
      block,
      rotationAboutAffine(2, 2, Math.PI / 4),
      { sampling: "linear", linearLight: false },
      rect(-4, -4, 16, 16),
    );
    expect(out).toBeDefined();
    expect(out?.pixels.getPixel(0, 0).a).toBe(0);
  });
});
