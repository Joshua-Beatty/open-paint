// @vitest-environment node
import { describe, expect, it } from "vitest";
import { defaultCmykProfile } from "./cmyk-profile";
import { convertToSrgb, ProfileError, profileSpace } from "./color-engine";
import { srgbIccProfile } from "./srgb-profile";
import { grayProfile, linearCurve, matrixProfile } from "./test-profiles";

describe("the color engine (WEB-COL-01)", () => {
  it("reads the space of an RGB, gray and CMYK profile", async () => {
    expect(await profileSpace(srgbIccProfile())).toBe("rgb");
    expect(await profileSpace(grayProfile(linearCurve()))).toBe("gray");
    expect(await profileSpace(defaultCmykProfile())).toBe("cmyk");
  });

  it("does not read the space of bytes that are not a profile", async () => {
    expect(await profileSpace(new Uint8Array([1, 2, 3, 4]))).toBeUndefined();
  });

  it("converts an sRGB profile to the same 8-bit values", async () => {
    const samples = new Uint8Array([0, 40, 128, 200, 255, 1]);
    const rgb = await convertToSrgb(srgbIccProfile(), { space: "rgb", bitsPerSample: 8, samples });
    expect(Array.from(rgb)).toEqual(Array.from(samples));
  });

  it("converts a linear RGB profile through the sRGB encoding", async () => {
    const rgb = await convertToSrgb(matrixProfile(linearCurve()), {
      space: "rgb",
      bitsPerSample: 8,
      samples: new Uint8Array([128, 128, 128]),
    });
    expect(Array.from(rgb)).toEqual([188, 188, 188]);
  });

  it("converts gray through the profile's tone curve", async () => {
    const rgb = await convertToSrgb(grayProfile(linearCurve()), {
      space: "gray",
      bitsPerSample: 8,
      samples: new Uint8Array([128]),
    });
    expect(Array.from(rgb)).toEqual([188, 188, 188]);
  });

  it("reads 16-bit samples", async () => {
    const samples = new Uint16Array([0, 0, 0, 0x8080, 0x8080, 0x8080, 0xffff, 0xffff, 0xffff]);
    const rgb = await convertToSrgb(matrixProfile(linearCurve()), {
      space: "rgb",
      bitsPerSample: 16,
      samples: new Uint8Array(samples.buffer),
    });
    expect(Array.from(rgb)).toEqual([0, 0, 0, 188, 188, 188, 255, 255, 255]);
  });

  it("converts more pixels than one transform call holds", async () => {
    const count = 70_000;
    const samples = new Uint8Array(count * 3);
    samples.set([255, 0, 0], (count - 1) * 3);
    const rgb = await convertToSrgb(srgbIccProfile(), { space: "rgb", bitsPerSample: 8, samples });
    expect(rgb.length).toBe(count * 3);
    expect(Array.from(rgb.subarray((count - 1) * 3))).toEqual([255, 0, 0]);
    expect(Array.from(rgb.subarray(0, 3))).toEqual([0, 0, 0]);
  });

  it("refuses samples whose space differs from the profile", async () => {
    await expect(
      convertToSrgb(srgbIccProfile(), {
        space: "cmyk",
        bitsPerSample: 8,
        samples: new Uint8Array(4),
      }),
    ).rejects.toBeInstanceOf(ProfileError);
  });

  it("refuses bytes that are not a profile", async () => {
    await expect(
      convertToSrgb(new Uint8Array([1, 2, 3, 4]), {
        space: "rgb",
        bitsPerSample: 8,
        samples: new Uint8Array(3),
      }),
    ).rejects.toBeInstanceOf(ProfileError);
  });
});
