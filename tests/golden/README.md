# Golden-image tests

Golden tests pin each kernel's output to a stored reference PNG. The Rust/WASM kernel is the
reference (ARC-02-08, WEB-GPU-03), so:

- **Node runner** (`src/*.test.ts`, part of `pnpm test`): runs the Rust/WASM kernel and requires an
  exact match with the stored reference (tolerance 0).
- **Browser runner** (`browser/*.golden.ts`, `pnpm test:golden`): runs the WGSL kernels in
  Chromium through `GpuCompositor` and requires a match within ±1 per 8-bit channel. It skips each
  case when the browser has no WebGPU adapter.

Today the cases cover four kernels:

- The 14 layer blend modes (DOC-BLD-01) at opacities 255, 128 and 1 (`blend-*`).
- Resampling (DOC-IMG-02): all nine filters, both directions (7x5 down, 21x15 up from a 13x9
  input), with and without gamma correction (`resample-*`). The Rust reference is `resampleSurface`
  in `@openpaint/document`. These are CPU-only: no WGSL twin exists yet, so the browser runner does
  not cover them.
- Gradients (TL-GRAD, TL-ALG-GRAD): all seven shapes, the three repeat rules, the premultiplied and
  transparency paths, the aliased lookup table, and the blend and Overwrite paths (`gradient-*`, 19
  cases over the blend input). The Rust reference is `gradientCpu` in `@openpaint/engine`. These are
  CPU-only: no WGSL twin exists yet, so the browser runner does not cover them.
- Gaussian Blur (FX-BLUR-GAUSS) at nine parameter sets: pass-through, each quality level, both
  gamma directions, the maximum radius, and the downsampled paths of quality 1-3 (`blur-*`). The
  Rust reference is `gaussianBlurCpu` in `@openpaint/effects`, and the WGSL side is
  `GpuGaussianBlur` in `@openpaint/engine`.

## Layout

| Path | What |
|---|---|
| `fixtures/blend/dst.png`, `src.png` | Stored inputs (32x32 RGBA, straight alpha) |
| `fixtures/blend/<mode>-<opacity>.png` | Stored reference outputs, one per case |
| `fixtures/blur/input.png` | Stored Gaussian Blur input (40x24 RGBA, straight alpha) |
| `fixtures/resample/input.png` | Stored resampling input (13x9 RGBA, straight alpha) |
| `fixtures/resample/<filter>-<down\|up>-<linear\|srgb>.png` | Stored reference resample, one per case |
| `fixtures/blur/<case-id>.png` | Stored reference blur output, one per parameter set |
| `fixtures/gradient/<case-id>.png` | Stored reference gradient output, one per case (over `fixtures/blend/dst.png`) |
| `src/cases.ts` | Case list. Shared by both runners, with no Node or DOM imports |
| `src/inputs.ts` | Deterministic input generator, used only when regenerating |
| `src/png.ts` | Small PNG codec (8-bit RGBA, all five filter types on decode) |
| `src/compare.ts` | Tolerances (`CPU_TOLERANCE` 0, `GPU_TOLERANCE` 1) and the image diff |
| `src/blend.test.ts` | Node runner for the blend cases |
| `src/blur.test.ts` | Node runner for the Gaussian Blur cases |
| `src/resample.test.ts` | Node runner for the resampling cases |
| `src/update-goldens.test.ts` | Regenerates the fixtures (gated by `GOLDEN_UPDATE=1`) |
| `browser/` | Vite page, WebGPU runner (`main.ts`) and the Playwright spec |
| `scripts/update-goldens.mjs` | What `pnpm golden:update` runs |
| `actual/` | Written by the Node runner when an output mismatches (git-ignored) |

## Running

```sh
pnpm test                 # Node runner, part of verify
pnpm test:golden          # WGSL in Chromium (needs a WebGPU adapter; otherwise cases skip)
pnpm golden:update        # rewrite every stored reference from the Rust kernel
```

To check the WGSL kernels on desktop Firefox's WebGPU (Playwright's bundled Firefox has none), start
the installed Firefox as a browser server and point the `firefox` project at it:

```sh
node tests/golden/scripts/firefox-server.mjs        # prints ws://...; leave it running
GOLDEN_FIREFOX_WS=ws://... pnpm --filter @openpaint/golden test:browser --project firefox
```

Shader compilers may fuse `a * b + c` into one multiply-add. Kernels whose result depends on the last
bit of such a sum (iterated orbits, noise lattice lookups) pass the product through `bitcast` and an
XOR with a uniform zero first, as Julia, Mandelbrot and Dents do, so it is rounded as in Rust.

## Adding a case

1. Add the case to `src/cases.ts`. For a new kernel, add its inputs and a case list next to the
   blend cases, and follow the same `id`, `expected` and tolerance pattern.
2. If the case needs new inputs, add them to `src/inputs.ts`, and point the case at the stored PNG
   path.
3. Run `pnpm golden:update`. Review the new PNG files, since they are the reference the rest of
   the suite will check against. Only commit them once the Rust output is what the spec requires.
4. Run `pnpm test` (exact, Rust) and `pnpm test:golden` (±1, WGSL). The browser runner needs a
   matching `*.golden.ts` case, so add one for any new kernel.

Regenerating references is a review step. Never regenerate just to make a test pass. If the Rust
output changed, first confirm the spec formula and the change are intended, then commit the new
PNGs with the change to the kernel. Hand-check the rounding if a fixture changes.

## Notes

- Transparent input pixels have zero color (`inputs.ts`), so the layer compositor's transparent
  start is an exact identity.
- Images are read and written with the codec in `src/png.ts`, not with the browser's canvas.
  Canvas premultiplies, which would hide the straight-alpha differences the goldens test.
- The browser runner requests the same WebGPU flags as the app's Playwright config
  (`apps/web/playwright.config.ts`), and it uses the Vite server on port 4174.
