/**
 * The registry of hatch patterns for a Hatch fill (TL-OPT-FILL). A pattern is an 8 × 8 one-bit
 * tile, named by its id, which the settings store and the options bar show. The rank of a pattern
 * (1-based, in registration order) selects its tile in the Rust kernels, so a pattern's rank must
 * match the Rust pattern table.
 */
export class HatchPatternRegistry {
  readonly #ids: string[] = [];

  /** Adds a pattern at the end of the list. A duplicate id is an error. */
  register(id: string): void {
    if (this.#ids.includes(id)) throw new Error(`Hatch pattern "${id}" is already registered.`);
    this.#ids.push(id);
  }

  /** The ids in registration order. */
  ids(): readonly string[] {
    return [...this.#ids];
  }

  /** The 1-based rank of a pattern id, or 0 when no pattern has that id. */
  rank(id: unknown): number {
    if (typeof id !== "string") return 0;
    return this.#ids.indexOf(id) + 1;
  }
}

/** The built-in hatch patterns, in the order of the Rust pattern table (TL-OPT-FILL). */
export const HATCH_PATTERNS = new HatchPatternRegistry();
for (const id of [
  "Horizontal",
  "Vertical",
  "ForwardDiagonal",
  "BackwardDiagonal",
  "Cross",
  "DiagonalCross",
  "Percent50",
  "DottedGrid",
]) {
  HATCH_PATTERNS.register(id);
}
