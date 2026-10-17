import { describe, expect, it } from "vitest";
import { BLEND_SIZE } from "./cases";
import { makeBlendInputs } from "./inputs";

describe("makeBlendInputs", () => {
  it("is deterministic and sized to the blend cases", () => {
    const first = makeBlendInputs();
    const second = makeBlendInputs();
    expect(first.dst.data).toEqual(second.dst.data);
    expect(first.src.data).toEqual(second.src.data);
    expect(first.dst.width).toBe(BLEND_SIZE);
    expect(first.src.height).toBe(BLEND_SIZE);
  });

  it("gives every transparent pixel zero color", () => {
    for (const { data } of [makeBlendInputs().dst, makeBlendInputs().src]) {
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) expect([data[i], data[i + 1], data[i + 2]]).toEqual([0, 0, 0]);
      }
    }
  });

  it("includes fully opaque, fully transparent and partial-alpha pixels", () => {
    const alphas = new Set<number>();
    const { data } = makeBlendInputs().dst;
    for (let i = 3; i < data.length; i += 4) alphas.add(data[i] ?? -1);
    expect(alphas.has(0)).toBe(true);
    expect(alphas.has(255)).toBe(true);
    expect([...alphas].some((a) => a > 0 && a < 255)).toBe(true);
  });
});
