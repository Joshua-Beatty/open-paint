import { RED_EYE_WGSL } from "@openpaint/effects";
import { describe, expect, it } from "vitest";
import { redEyeFactors } from "./gpu-red-eye";

describe("Red Eye Removal on the GPU", () => {
  it("takes its threshold and correction rounded to f32 as the Rust reference computes them", () => {
    const f = Math.fround;
    for (const strength of [1, 2, 3, 4, 5]) {
      const { ratio, correction } = redEyeFactors(strength);
      expect(ratio).toBe(f(f(1.9) - f(f(0.1) * strength)));
      expect(correction).toBe(f(strength / 5));
    }
    expect(redEyeFactors(5).correction).toBe(1);
  });

  it("reads byte values from the reference's table and rounds the threshold product", () => {
    // A WGSL division is approximate, and a fused multiply-add can move a pixel across a threshold.
    const shader = RED_EYE_WGSL.replace(/\/\/.*$/gm, "");
    expect(shader).not.toMatch(/\/ 255\.0/);
    expect(shader).toContain("r <= rounded(p.ratio * green_blue)");
  });
});
