/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { rotationAboutAffine, translationAffine } from "./affine";
import { composeFloating, composeFloatingRows, type FloatingComposeJob } from "./floating-compose";
import { rect } from "./geometry";
import { ellipsePolygon } from "./selection-polygons";
import { Surface } from "./surface";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

function pattern(width: number, height: number, seed: number): Surface {
  const surface = new Surface(width, height);
  for (let i = 0; i < surface.data.length; i++) surface.data[i] = (i * seed + (i >> 5)) % 256;
  return surface;
}

describe("composeFloatingRows", () => {
  const area = rect(3, 2, 40, 31);
  const pixels = pattern(20, 14, 37);
  const outline = [ellipsePolygon(rect(1, 0.5, 18, 13))];
  const coverage = new Uint8Array(20 * 14).map((_, i) => (i * 7) % 256);
  const jobs: Record<string, FloatingComposeJob> = {
    rotated: {
      pixels,
      coverage,
      outline,
      quality: "antialiased",
      area,
      base: pattern(40, 31, 11),
      stamps: [
        {
          transform: rotationAboutAffine(20, 15, 0.3),
          options: { sampling: "linear", linearLight: false },
        },
      ],
      placement: {
        transform: { ...rotationAboutAffine(22, 16, -0.7), e: 9.3 },
        options: { sampling: "cubic", linearLight: true },
      },
    },
    moved: {
      pixels,
      coverage,
      outline,
      quality: "aliased",
      area,
      base: pattern(40, 31, 5),
      stamps: [],
      placement: {
        transform: translationAffine(17, 9),
        options: { sampling: "nearest", linearLight: true },
      },
    },
  };
  for (const [name, job] of Object.entries(jobs)) {
    it(`joins bands into the whole result byte for byte: ${name}`, () => {
      const whole = composeFloating(job);
      const drawn: number[] = [];
      const stamped: number[] = [];
      for (const [first, count] of [
        [0, 7],
        [7, 1],
        [8, 23],
      ] as const) {
        const base = new Surface(area.width, count);
        base.copyFrom(job.base, rect(0, first, area.width, count), 0, 0);
        const band = composeFloatingRows({ ...job, base }, first, count);
        drawn.push(...band.drawn.data);
        stamped.push(...band.base.data);
      }
      expect(drawn).toEqual([...whole.drawn.data]);
      expect(stamped).toEqual([...whole.base.data]);
    });
  }
});
