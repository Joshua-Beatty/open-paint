/** The character styles of the Text tool (TL-OPT-TEXT "Styles"). */
export const TEXT_STYLES = ["Bold", "Italic", "Underline", "Strikeout"] as const;

export type TextStyle = (typeof TEXT_STYLES)[number];

/** The stored value of "no styles", as the setting's default has it (SET-STO-03). */
const NO_STYLES = "Regular";

/** The styles a stored value turns on. The value is a comma-separated list, and "Regular" is none. */
export function textStyles(value: unknown): ReadonlySet<TextStyle> {
  const names = typeof value === "string" ? value.split(",").map((name) => name.trim()) : [];
  return new Set(
    TEXT_STYLES.filter((style) => names.some((name) => name.toLowerCase() === style.toLowerCase())),
  );
}

/** The stored value with one style turned on or off, in the fixed style order. */
export function toggleTextStyle(value: unknown, style: TextStyle): string {
  const styles = new Set(textStyles(value));
  if (styles.has(style)) styles.delete(style);
  else styles.add(style);
  const names = TEXT_STYLES.filter((name) => styles.has(name));
  return names.length === 0 ? NO_STYLES : names.join(",");
}

/**
 * The font size in pixels for a size in points (TL-OPT-TEXT "Font size metric"). "Points (image
 * DPI)" uses the image's resolution, and "Fixed (96 DPI)" always uses 96 dots per inch.
 */
export function fontSizePx(points: number, metric: unknown, imageDpi: number): number {
  const dpi = metric === "Fixed96Dpi" ? 96 : imageDpi;
  return (points * dpi) / 72;
}

/** The font family a stored value names when it is one of the available families. */
export function resolveFamily(
  stored: unknown,
  available: readonly string[],
  fallback: string,
): string {
  if (typeof stored === "string" && available.includes(stored)) return stored;
  return available.includes(fallback) ? fallback : (available[0] ?? fallback);
}
