import { DEFAULT_DPI, type Resolution } from "@openpaint/document";
import type { MessageId, MessageValues, Translate } from "@openpaint/i18n";
import { describe, expect, it } from "vitest";
import {
  anchorFromSetting,
  defaultDotsPerUnit,
  defaultNewImageSize,
  dotsPerUnitOf,
  draftResolution,
  fillColor,
  fillFromSetting,
  gammaSetting,
  isDraftValid,
  linearLightFromSetting,
  memoryBytes,
  memoryText,
  printSize,
  printUnitFromSetting,
  printUnitSetting,
  resamplingFromSetting,
  type SizeDraft,
  sizeDraft,
  targetSize,
  withDotsPerUnit,
  withHeight,
  withMode,
  withPercent,
  withPrintWidth,
  withUnit,
  withWidth,
} from "./size-draft";

const CURRENT = { width: 800, height: 600 };

/** A translator that shows the message id and its values, so tests can read the text. */
const t = ((id: MessageId, values?: MessageValues) =>
  values === undefined ? id : `${id}:${Object.values(values).join(",")}`) as Translate;

function draft(overrides: Partial<SizeDraft> = {}): SizeDraft {
  return {
    ...sizeDraft(CURRENT, { keepAspect: false, unit: "inch", dotsPerUnit: DEFAULT_DPI }),
    ...overrides,
  };
}

describe("target size (DOC-DOC-01, DOC-IMG-02)", () => {
  it("accepts whole sides from 1 to 262,144 and nothing else", () => {
    expect(targetSize(draft({ width: 1, height: 262_144 }), CURRENT)).toEqual({
      width: 1,
      height: 262_144,
    });
    expect(targetSize(draft({ width: 0, height: 10 }), CURRENT)).toBeUndefined();
    expect(targetSize(draft({ width: 262_145, height: 10 }), CURRENT)).toBeUndefined();
    expect(targetSize(draft({ width: 10.5, height: 10 }), CURRENT)).toBeUndefined();
    expect(targetSize(draft({ width: Number.NaN, height: 10 }), CURRENT)).toBeUndefined();
  });

  it("scales both sides by a percentage within the spinner range", () => {
    const half = withMode(draft(), CURRENT, "percent");
    expect(targetSize(withPercent(half, 50), CURRENT)).toEqual({ width: 400, height: 300 });
    expect(targetSize(withPercent(half, 0), CURRENT)).toBeUndefined();
    expect(targetSize(withPercent(half, 2001), CURRENT)).toBeUndefined();
    expect(targetSize(withPercent(half, 0.01), CURRENT)).toBeUndefined();
  });

  it("switching to typed pixels starts from the shown size", () => {
    const scaled = withPercent(withMode(draft(), CURRENT, "percent"), 25);
    const typed = withMode(scaled, CURRENT, "pixels");
    expect(typed.mode).toBe("pixels");
    expect(typed.width).toBe(200);
    expect(typed.height).toBe(150);
  });
});

describe("aspect ratio linking", () => {
  it("links the height to the width while Maintain aspect ratio is on", () => {
    const linked = draft({ keepAspect: true });
    expect(withWidth(linked, CURRENT, 400)).toMatchObject({ width: 400, height: 300 });
    expect(withHeight(linked, CURRENT, 300)).toMatchObject({ width: 400, height: 300 });
  });

  it("changes one side at a time when the aspect ratio is off", () => {
    const free = draft({ keepAspect: false });
    expect(withWidth(free, CURRENT, 400)).toMatchObject({ width: 400, height: 600 });
    expect(withHeight(free, CURRENT, 100)).toMatchObject({ width: 800, height: 100 });
  });
});

describe("resolution and print size (DOC-DOC-03)", () => {
  it("prints the pixels at the resolution, and keeps the resolution in range", () => {
    const at96 = draft({ width: 960, height: 96 });
    expect(printSize(at96, { width: 960, height: 96 })).toEqual({ width: 10, height: 1 });
    expect(draftResolution(draft({ dotsPerUnit: 0.01 }))).toEqual({
      unit: "inch",
      x: 0.01,
      y: 0.01,
    });
    expect(draftResolution(draft({ dotsPerUnit: 0 }))).toBeUndefined();
    expect(draftResolution(draft({ dotsPerUnit: 65_537 }))).toBeUndefined();
  });

  it("sets the resolution from a print width, so the pixels fit that length", () => {
    const set = withPrintWidth(draft(), CURRENT, 8);
    expect(set.dotsPerUnit).toBe(100);
    expect(printSize(set, CURRENT).width).toBeCloseTo(8, 10);
  });

  it("converts the resolution when the unit changes, and keeps the printed size", () => {
    const inches = draft({ dotsPerUnit: 96 });
    const cm = withUnit(inches, "centimeter");
    expect(cm.unit).toBe("centimeter");
    expect(cm.dotsPerUnit).toBeCloseTo(96 / 2.54, 10);
    expect(printSize(cm, CURRENT).width).toBeCloseTo(printSize(inches, CURRENT).width * 2.54, 8);
  });

  it("reads a document's resolution in the draft's unit", () => {
    const pixel: Resolution = { unit: "pixel", x: 1, y: 1 };
    expect(dotsPerUnitOf(pixel, "inch")).toBe(DEFAULT_DPI);
    expect(dotsPerUnitOf({ unit: "inch", x: 96, y: 96 }, "centimeter")).toBeCloseTo(96 / 2.54);
    expect(withDotsPerUnit(draft(), 300).dotsPerUnit).toBe(300);
  });

  it("validity needs a usable size and resolution", () => {
    expect(isDraftValid(draft(), CURRENT)).toBe(true);
    expect(isDraftValid(draft({ width: 0 }), CURRENT)).toBe(false);
    expect(isDraftValid(draft({ dotsPerUnit: Number.NaN }), CURRENT)).toBe(false);
  });
});

describe("memory estimate (DOC-IMG-02)", () => {
  it("counts four bytes per pixel and per layer", () => {
    expect(memoryBytes({ width: 800, height: 600 }, 2)).toBe(3_840_000);
  });

  it("shows B, KB, MB or GB with one decimal", () => {
    expect(memoryText(512, t)).toBe("image.memory.bytes:512");
    expect(memoryText(2048, t)).toBe("image.memory.kilobytes:2.0");
    expect(memoryText(1_920_000, t)).toBe("image.memory.megabytes:1.8");
    expect(memoryText(3 * 1024 ** 3, t)).toBe("image.memory.gigabytes:3.0");
  });
});

describe("default size of a new image (DOC-NEW-01)", () => {
  it("uses 800 x 600 on a landscape screen and 600 x 800 on a portrait one", () => {
    expect(
      defaultNewImageSize({ screen: { width: 1920, height: 1080 }, devicePixelRatio: 1 }),
    ).toEqual({
      width: 800,
      height: 600,
    });
    expect(
      defaultNewImageSize({ screen: { width: 1080, height: 1920 }, devicePixelRatio: 1 }),
    ).toEqual({
      width: 600,
      height: 800,
    });
  });

  it("multiplies the base size by the device pixel ratio", () => {
    expect(
      defaultNewImageSize({ screen: { width: 1920, height: 1080 }, devicePixelRatio: 1.5 }),
    ).toEqual({
      width: 1200,
      height: 900,
    });
  });

  it("prefers the clipboard size over the screen", () => {
    const clipboard = { width: 37, height: 19 };
    expect(
      defaultNewImageSize({
        screen: { width: 1920, height: 1080 },
        devicePixelRatio: 2,
        clipboard,
      }),
    ).toEqual(clipboard);
  });

  it("uses 96 px per inch, or its centimeter equivalent", () => {
    expect(defaultDotsPerUnit("inch")).toBe(96);
    expect(defaultDotsPerUnit("centimeter")).toBeCloseTo(37.795, 3);
  });
});

describe("remembered choices", () => {
  it("maps the print unit setting, with Inch for anything else", () => {
    expect(printUnitFromSetting("Centimeter")).toBe("centimeter");
    expect(printUnitFromSetting("Inch")).toBe("inch");
    expect(printUnitFromSetting("Pixel")).toBe("inch");
    expect(printUnitSetting("centimeter")).toBe("Centimeter");
  });

  it("maps the anchor and fill settings, with the defaults for unknown values", () => {
    expect(anchorFromSetting("BottomRight")).toBe("bottomRight");
    expect(anchorFromSetting("Nowhere")).toBe("topLeft");
    expect(fillFromSetting("SecondaryColor")).toBe("SecondaryColor");
    expect(fillFromSetting("Plaid")).toBe("Transparent");
  });

  it("maps resampling and gamma settings, with Bicubic and linear light by default", () => {
    expect(resamplingFromSetting("lanczos3")).toBe("lanczos3");
    expect(resamplingFromSetting("superSampling")).toBe("bicubic");
    expect(linearLightFromSetting("Companded")).toBe(false);
    expect(linearLightFromSetting("Linear")).toBe(true);
    expect(gammaSetting(false)).toBe("Companded");
  });

  it("fills with the primary or secondary color, or a fixed color", () => {
    const primary = { r: 10, g: 20, b: 30, a: 40 };
    const secondary = { r: 1, g: 2, b: 3, a: 4 };
    expect(fillColor("PrimaryColor", primary, secondary)).toEqual(primary);
    expect(fillColor("SecondaryColor", primary, secondary)).toEqual(secondary);
    expect(fillColor("White", primary, secondary)).toEqual({ r: 255, g: 255, b: 255, a: 255 });
    expect(fillColor("Black", primary, secondary)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(fillColor("Transparent", primary, secondary)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });
});

describe("resolution type", () => {
  it("is the same unit object the document expects", () => {
    expect(draftResolution(draft({ unit: "centimeter", dotsPerUnit: 37.8 }))).toEqual({
      unit: "centimeter",
      x: 37.8,
      y: 37.8,
    });
  });
});
