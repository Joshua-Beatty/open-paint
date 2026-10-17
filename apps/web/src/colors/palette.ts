import { argbHex, parseArgbHex, type Rgba, WHITE } from "./color-math";

/** Every palette has exactly this many colors (DOC-COL-03). */
export const PALETTE_SIZE = 96;

export const PALETTE_EXTENSION = ".txt";

/** The header written at the top of every saved palette file (DOC-COL-03). */
export const PALETTE_HEADER = [
  "; OpenPaint Palette File",
  "; Lines that start with a semicolon are comments",
  "; Colors are written as 8-digit hexadecimal numbers: aarrggbb",
  "; For example, this would specify green: FF00FF00",
  "; The alpha ('aa') value specifies how transparent a color is. FF is fully opaque, 00 is fully transparent.",
  "; A palette must consist of ninety six (96) colors. If there are less than this, the remaining color",
  "; slots will be set to white (FFFFFFFF). If there are more, then the remaining colors will be ignored.",
];

/** The 96 default colors, six rows of sixteen, as AARRGGBB (DOC-COL-02). */
const DEFAULT_PALETTE_ROWS: readonly string[] = [
  "FF000000 FF404040 FFFF0000 FFFF6A00 FFFFD800 FFB6FF00 FF4CFF00 FF00FF21 FF00FF90 FF00FFFF FF0094FF FF0026FF FF4800FF FFB200FF FFFF00DC FFFF006E",
  "FFFFFFFF FF808080 FF7F0000 FF7F3300 FF7F6A00 FF5B7F00 FF267F00 FF007F0E FF007F46 FF007F7F FF004A7F FF00137F FF21007F FF57007F FF7F006E FF7F0037",
  "FFA0A0A0 FF303030 FFFF7F7F FFFFB27F FFFFE97F FFDAFF7F FFA5FF7F FF7FFF8E FF7FFFC5 FF7FFFFF FF7FC9FF FF7F92FF FFA17FFF FFD67FFF FFFF7FED FFFF7FB6",
  "FFC0C0C0 FF606060 FF7F3F3F FF7F593F FF7F743F FF6D7F3F FF527F3F FF3F7F47 FF3F7F62 FF3F7F7F FF3F647F FF3F497F FF503F7F FF6B3F7F FF7F3F76 FF7F3F5B",
  "80000000 80404040 80FF0000 80FF6A00 80FFD800 80B6FF00 804CFF00 8000FF21 8000FF90 8000FFFF 800094FF 800026FF 804800FF 80B200FF 80FF00DC 80FF006E",
  "80FFFFFF 80808080 807F0000 807F3300 807F6A00 805B7F00 80267F00 80007F0E 80007F46 80007F7F 80004A7F 8000137F 8021007F 8057007F 807F006E 807F0037",
];

function parseColorList(text: string): Rgba[] {
  return text.split(" ").map((hex) => {
    const color = parseArgbHex(hex);
    if (color === null) throw new Error(`Invalid default palette color "${hex}".`);
    return color;
  });
}

/** The built-in default palette. It is never modified in place. */
export const DEFAULT_PALETTE: readonly Rgba[] = Object.freeze(
  DEFAULT_PALETTE_ROWS.flatMap(parseColorList),
);

/**
 * Reads a palette file (DOC-COL-03). A UTF-8 byte-order mark is accepted. Text after ";" is
 * removed, and each remaining non-empty line is one slot. A line that cannot be parsed is white.
 * Missing slots are white and extra slots are dropped.
 */
export function parsePaletteText(text: string): Rgba[] {
  const body = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const slots: Rgba[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.split(";", 1)[0]?.trim() ?? "";
    if (line === "") continue;
    slots.push(parseArgbHex(line) ?? WHITE);
  }
  return Array.from({ length: PALETTE_SIZE }, (_, index) => slots[index] ?? WHITE);
}

/** Writes a palette file: the header, then one AARRGGBB color per line. */
export function serializePalette(colors: readonly Rgba[]): string {
  const slots = Array.from({ length: PALETTE_SIZE }, (_, index) => colors[index] ?? WHITE);
  return `${[...PALETTE_HEADER, ...slots.map(argbHex)].join("\r\n")}\r\n`;
}

const INVALID_NAME_CHARACTERS = /[\\/:*?"<>|]/;

export type PaletteNameProblem = "empty" | "invalid";

/**
 * Checks a palette name (DOC-COL-04). It must not be empty and must not hold a character that is
 * invalid in file names, so the palette can be exported unchanged. Returns null when it is valid.
 */
export function paletteNameProblem(name: string): PaletteNameProblem | null {
  if (name.trim() === "") return "empty";
  if (INVALID_NAME_CHARACTERS.test(name)) return "invalid";
  return null;
}

/** The palette name of a file: its file name without the .txt extension. */
export function paletteNameFromFileName(fileName: string): string {
  const lower = fileName.toLowerCase();
  const base = lower.endsWith(PALETTE_EXTENSION)
    ? fileName.slice(0, -PALETTE_EXTENSION.length)
    : fileName;
  return base.trim();
}
