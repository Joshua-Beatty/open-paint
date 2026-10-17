import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resampleSurface, Surface } from "@openpaint/document";
import {
  addNoiseCpu,
  alignObjectCpu,
  bokehBlurCpu,
  distortAffineCpu,
  dropShadowCpu,
  edgeDetectCpu,
  embossCpu,
  fragmentBlurCpu,
  frostedGlassCpu,
  gaussianBlurCpu,
  glowCpu,
  inkSketchCpu,
  medianBlurCpu,
  morphologyCpu,
  motionBlurCpu,
  noiseCpu,
  oilPaintingCpu,
  outlineCpu,
  pencilSketchCpu,
  pixelateCpu,
  radialBlurCpu,
  redEyeCpu,
  reduceNoiseCpu,
  reliefCpu,
  rotateZoomCpu,
  sharpenCpu,
  sketchBlurCpu,
  softenPortraitCpu,
  squareBlurCpu,
  straightenCpu,
  surfaceBlurCpu,
  vignetteCpu,
  zoomBlurCpu,
} from "@openpaint/effects";
import { compositeRgba8, gradientCpu, initCpu } from "@openpaint/engine";
import { describe, expect, it } from "vitest";
import { adjustmentReference } from "./adjust-reference";
import {
  ADD_NOISE_CASES,
  ADJUSTMENT_CASES,
  ADJUSTMENT_INPUT,
  ALIGN_OBJECT_CASES,
  alignObjectCoverage,
  alignObjectInput,
  BLEND_CASES,
  BLEND_INPUTS,
  BLUR_CASES,
  BLUR_INPUT,
  BOKEH_CASES,
  DISTORT_CASES,
  DROP_SHADOW_CASES,
  EDGE_DETECT_CASES,
  EMBOSS_CASES,
  FRAGMENT_CASES,
  FROST_CASES,
  GLOW_CASES,
  GRADIENT_CASES,
  GRADIENT_INPUT,
  gradientColorOf,
  INK_CASES,
  MEDIAN_CASES,
  MORPHOLOGY_CASES,
  MOTION_CASES,
  NOISE_CASES,
  OIL_CASES,
  OUTLINE_CASES,
  PENCIL_CASES,
  PIXELATE_CASES,
  QUANTIZE_CASES,
  QUANTIZE_INPUT,
  RADIAL_CASES,
  RED_EYE_CASES,
  REDUCE_NOISE_CASES,
  RELIEF_CASES,
  RESAMPLE_CASES,
  RESAMPLE_INPUT,
  RESAMPLE_SIZES,
  ROTATE_ZOOM_CASES,
  redEyeCoverage,
  redEyeInput,
  SHARPEN_CASES,
  SKETCH_CASES,
  SOFTEN_CASES,
  SQUARE_CASES,
  STRAIGHTEN_CASES,
  SURFACE_CASES,
  VIGNETTE_CASES,
  WARP_CASES,
  ZOOM_CASES,
} from "./cases";
import { diffImages } from "./compare";
import {
  makeAdjustmentInput,
  makeBlendInputs,
  makeBlurInput,
  makeQuantizeInput,
  makeResampleInput,
} from "./inputs";
import { readReference, writeReference } from "./node-io";
import { quantizedImage } from "./quantize-output";
import { warpReference } from "./warp-reference";

/**
 * Rewrites every stored golden from the Rust reference. Runs only through
 * `pnpm golden:update` (which sets GOLDEN_UPDATE=1), never in a normal test run.
 */
describe.runIf(process.env.GOLDEN_UPDATE === "1")("update golden fixtures", () => {
  it("writes the blend inputs and the Rust reference outputs", async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));

    const inputs = makeBlendInputs();
    await writeReference(BLEND_INPUTS.dst, inputs.dst);
    await writeReference(BLEND_INPUTS.src, inputs.src);
    // Read the inputs back so the outputs are computed from exactly what is stored.
    const dst = await readReference(BLEND_INPUTS.dst);
    const src = await readReference(BLEND_INPUTS.src);
    expect(diffImages(dst, inputs.dst).maxDifference).toBe(0);

    for (const kase of BLEND_CASES) {
      const out = { ...dst, data: new Uint8Array(dst.data) };
      compositeRgba8(out.data, src.data, kase.mode, kase.opacity);
      await writeReference(kase.expected, out);
    }
  });

  it("writes the resampling input and the Rust reference outputs", async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));

    await writeReference(RESAMPLE_INPUT, makeResampleInput());
    const stored = await readReference(RESAMPLE_INPUT);
    const input = new Surface(stored.width, stored.height, new Uint8ClampedArray(stored.data));

    for (const kase of RESAMPLE_CASES) {
      const size = RESAMPLE_SIZES[kase.direction];
      const out = resampleSurface(input, size.width, size.height, {
        filter: kase.filter,
        linearLight: kase.linearLight,
      });
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
  });

  it("writes the quantization input and the Rust reference outputs", async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));

    await writeReference(QUANTIZE_INPUT, makeQuantizeInput());
    const input = await readReference(QUANTIZE_INPUT);

    for (const kase of QUANTIZE_CASES) {
      await writeReference(kase.expected, quantizedImage(input, kase));
    }
  });

  it("writes the gradient outputs from the Rust reference", async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));

    const stored = await readReference(GRADIENT_INPUT);
    const input = new Surface(stored.width, stored.height, new Uint8ClampedArray(stored.data));

    for (const kase of GRADIENT_CASES) {
      const out = gradientCpu(input, {
        shape: kase.shape,
        repeat: kase.repeat,
        start: { x: kase.start[0], y: kase.start[1] },
        end: { x: kase.end[0], y: kase.end[1] },
        startColor: gradientColorOf(kase.startColor),
        endColor: gradientColorOf(kase.endColor),
        alphaOnly: kase.alphaOnly,
        antialias: kase.antialias,
        blend: kase.blend,
      });
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
  });

  it("writes the adjustment input and the Rust reference outputs", async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));

    await writeReference(ADJUSTMENT_INPUT, makeAdjustmentInput());
    const stored = await readReference(ADJUSTMENT_INPUT);
    const input = new Surface(stored.width, stored.height, new Uint8ClampedArray(stored.data));

    for (const kase of ADJUSTMENT_CASES) {
      const out = adjustmentReference(kase, input);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
  });

  it("writes the blur input and the Rust reference outputs", async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));

    await writeReference(BLUR_INPUT, makeBlurInput());
    const stored = await readReference(BLUR_INPUT);
    const input = new Surface(stored.width, stored.height, new Uint8ClampedArray(stored.data));

    for (const kase of BLUR_CASES) {
      const out = gaussianBlurCpu(input, {
        radius: kase.radius,
        gammaBoost: kase.gammaBoost,
        quality: kase.quality,
      });
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
  });

  it("writes the distortion and noise outputs from the Rust reference", async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));

    const stored = await readReference(BLUR_INPUT);
    const input = new Surface(stored.width, stored.height, new Uint8ClampedArray(stored.data));

    for (const kase of DISTORT_CASES) {
      const out = distortAffineCpu(input, kase.matrix, kase.quality, kase.edge);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of WARP_CASES) {
      const out = warpReference(kase, input);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of FROST_CASES) {
      const out = frostedGlassCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of PIXELATE_CASES) {
      const out = pixelateCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of MORPHOLOGY_CASES) {
      const out = morphologyCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of FRAGMENT_CASES) {
      const out = fragmentBlurCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of MOTION_CASES) {
      const out = motionBlurCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of RADIAL_CASES) {
      const out = radialBlurCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of ZOOM_CASES) {
      const out = zoomBlurCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of MEDIAN_CASES) {
      const out = medianBlurCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of SURFACE_CASES) {
      const out = surfaceBlurCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of SQUARE_CASES) {
      const out = squareBlurCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of SKETCH_CASES) {
      const out = sketchBlurCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of BOKEH_CASES) {
      const out = bokehBlurCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of INK_CASES) {
      const out = inkSketchCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of OIL_CASES) {
      const out = oilPaintingCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of PENCIL_CASES) {
      const out = pencilSketchCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of GLOW_CASES) {
      const out = glowCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of SOFTEN_CASES) {
      const out = softenPortraitCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of SHARPEN_CASES) {
      const out = sharpenCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of EDGE_DETECT_CASES) {
      const out = edgeDetectCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of EMBOSS_CASES) {
      const out = embossCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of RELIEF_CASES) {
      const out = reliefCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of OUTLINE_CASES) {
      const out = outlineCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of DROP_SHADOW_CASES) {
      const out = dropShadowCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    const eyes = redEyeInput();
    const eyesSurface = new Surface(eyes.width, eyes.height, new Uint8ClampedArray(eyes.data));
    for (const kase of RED_EYE_CASES) {
      const out = redEyeCpu(
        eyesSurface,
        kase.params,
        redEyeCoverage(kase, eyes.width, eyes.height),
      );
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of STRAIGHTEN_CASES) {
      const out = straightenCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of VIGNETTE_CASES) {
      const out = vignetteCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of ROTATE_ZOOM_CASES) {
      const out = rotateZoomCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of ADD_NOISE_CASES) {
      const out = addNoiseCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of REDUCE_NOISE_CASES) {
      const out = reduceNoiseCpu(input, kase.params);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
    for (const kase of NOISE_CASES) {
      const out = noiseCpu(input.width, input.height, kase.seed);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
  });

  it("writes the Align Object references", async () => {
    const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
    await initCpu(await readFile(wasmPath));

    const source = alignObjectInput();
    const input = new Surface(source.width, source.height, new Uint8ClampedArray(source.data));
    for (const kase of ALIGN_OBJECT_CASES) {
      const coverage = alignObjectCoverage(kase, source.width, source.height);
      const out = alignObjectCpu(input, kase.params, coverage);
      await writeReference(kase.expected, {
        width: out.width,
        height: out.height,
        data: new Uint8Array(out.data),
      });
    }
  });
});
