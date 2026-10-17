import { describe, expect, it } from "vitest";
import { argbHex, type Rgba, WHITE } from "./color-math";
import {
  DEFAULT_PALETTE,
  PALETTE_HEADER,
  PALETTE_SIZE,
  paletteNameFromFileName,
  paletteNameProblem,
  parsePaletteText,
  serializePalette,
} from "./palette";

function argb(hex: string): Rgba {
  const value = Number.parseInt(hex, 16);
  return {
    a: (value >>> 24) & 0xff,
    r: (value >>> 16) & 0xff,
    g: (value >>> 8) & 0xff,
    b: value & 0xff,
  };
}

describe("default palette (DOC-COL-02)", () => {
  it("has 96 colors in six rows of sixteen", () => {
    expect(DEFAULT_PALETTE).toHaveLength(PALETTE_SIZE);
    expect(PALETTE_SIZE).toBe(96);
  });

  it("starts row one with black and dark gray, and ends it with magenta-pink", () => {
    expect(argbHex(DEFAULT_PALETTE[0] ?? WHITE)).toBe("FF000000");
    expect(argbHex(DEFAULT_PALETTE[1] ?? WHITE)).toBe("FF404040");
    expect(argbHex(DEFAULT_PALETTE[15] ?? WHITE)).toBe("FFFF006E");
  });

  it("starts row two with white", () => {
    expect(DEFAULT_PALETTE[16]).toEqual(argb("FFFFFFFF"));
    expect(DEFAULT_PALETTE[31]).toEqual(argb("FF7F0037"));
  });

  it("holds the rows at 50 % alpha after rows one and two", () => {
    expect(DEFAULT_PALETTE[64]).toEqual(argb("80000000"));
    expect(DEFAULT_PALETTE[80]).toEqual(argb("80FFFFFF"));
    expect(DEFAULT_PALETTE[95]).toEqual(argb("807F0037"));
    for (let index = 0; index < 32; index++) {
      const opaque = DEFAULT_PALETTE[index] ?? WHITE;
      const translucent = DEFAULT_PALETTE[index + 64] ?? WHITE;
      expect(translucent).toEqual({ ...opaque, a: 128 });
    }
  });
});

describe("palette files", () => {
  it("reads one color per line and ignores comments and blank lines", () => {
    const palette = parsePaletteText(
      [
        "; a comment",
        "FF00FF00 ; green",
        "",
        "  80FF0000  ",
        ";",
        ...Array(95).fill("FF000000"),
      ].join("\n"),
    );
    expect(palette).toHaveLength(PALETTE_SIZE);
    expect(palette[0]).toEqual(argb("FF00FF00"));
    expect(palette[1]).toEqual(argb("80FF0000"));
  });

  it("accepts a UTF-8 byte-order mark", () => {
    const palette = parsePaletteText(`\uFEFFFF00FF00\n${"FFFFFFFF\n".repeat(95)}`);
    expect(palette[0]).toEqual(argb("FF00FF00"));
  });

  it("fills missing slots with white and drops extra colors", () => {
    const short = parsePaletteText("FF000000\n");
    expect(short[0]).toEqual(argb("FF000000"));
    expect(short[1]).toEqual(WHITE);
    expect(short[95]).toEqual(WHITE);
    const long = parsePaletteText(Array(120).fill("FF123456").join("\n"));
    expect(long).toHaveLength(PALETTE_SIZE);
  });

  it("counts an unparseable line as white", () => {
    const palette = parsePaletteText("FF000000\nnot-a-color\nFF000000\n");
    expect(palette[1]).toEqual(WHITE);
    expect(palette[2]).toEqual(argb("FF000000"));
  });

  it("writes the header, then 96 AARRGGBB lines", () => {
    const text = serializePalette(DEFAULT_PALETTE);
    const lines = text.trimEnd().split(/\r?\n/);
    expect(lines.slice(0, PALETTE_HEADER.length)).toEqual(PALETTE_HEADER);
    const colors = lines.slice(PALETTE_HEADER.length);
    expect(colors).toHaveLength(PALETTE_SIZE);
    expect(colors[0]).toBe("FF000000");
    expect(colors[95]).toBe("807F0037");
  });

  it("round-trips the default palette exactly", () => {
    expect(parsePaletteText(serializePalette(DEFAULT_PALETTE))).toEqual(DEFAULT_PALETTE);
  });

  it("pads a short palette with white when it is saved", () => {
    const text = serializePalette([argb("FF112233")]);
    const parsed = parsePaletteText(text);
    expect(parsed[0]).toEqual(argb("FF112233"));
    expect(parsed[95]).toEqual(WHITE);
  });
});

describe("palette names", () => {
  it("rejects an empty name and one with only spaces", () => {
    expect(paletteNameProblem("")).toBe("empty");
    expect(paletteNameProblem("   ")).toBe("empty");
  });

  it("rejects the characters that file names cannot hold", () => {
    for (const bad of ["a\\b", "a/b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b"]) {
      expect(paletteNameProblem(bad)).toBe("invalid");
    }
  });

  it("accepts an ordinary name", () => {
    expect(paletteNameProblem("My Palette 2")).toBeNull();
  });

  it("takes the name of a file without its extension", () => {
    expect(paletteNameFromFileName("Sky.txt")).toBe("Sky");
    expect(paletteNameFromFileName("Sky.TXT")).toBe("Sky");
    expect(paletteNameFromFileName("Dusk.palette")).toBe("Dusk.palette");
  });
});
