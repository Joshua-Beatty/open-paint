import { describe, expect, it } from "vitest";
import { cycleChoice, stepValue } from "./options";

describe("stepValue", () => {
  it("steps and clamps to the range", () => {
    expect(stepValue(2, -1, 1, 2000)).toBe(1);
    expect(stepValue(1, -5, 1, 2000)).toBe(1);
    expect(stepValue(1999, 5, 1, 2000)).toBe(2000);
  });

  it("does not drift on fractional steps", () => {
    let value = 0.5;
    for (let index = 0; index < 100; index++) value = stepValue(value, 0.01, 0, 1);
    expect(value).toBe(1);
    expect(stepValue(0.1 + 0.2, 0, 0, 1)).toBe(0.3);
  });
});

describe("cycleChoice", () => {
  const dashes = ["Solid", "Dashes", "Dotted"] as const;

  it("moves forward and wraps", () => {
    expect(cycleChoice(dashes, "Solid", 1)).toBe("Dashes");
    expect(cycleChoice(dashes, "Dotted", 1)).toBe("Solid");
  });

  it("moves back and wraps", () => {
    expect(cycleChoice(dashes, "Solid", -1)).toBe("Dotted");
  });

  it("starts from the first choice when the current value is not listed", () => {
    expect(cycleChoice(dashes, "Other" as never, 1)).toBe("Solid");
  });

  it("rejects an empty list", () => {
    expect(() => cycleChoice([] as readonly string[], "x", 1)).toThrow();
  });
});
