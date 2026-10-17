import { describe, expect, it } from "vitest";
import { firstHidden } from "./overflow-math";

describe("firstHidden", () => {
  it("keeps every item when the row is wide enough", () => {
    expect(firstHidden([100, 100, 100], 8, 316, 30)).toBeUndefined();
    expect(firstHidden([], 8, 0, 30)).toBeUndefined();
  });

  it("hides from the first item that leaves no room for the More button", () => {
    // 100 + 8 + 100 = 208 fits in 315 - 30 - 8; the third item would not.
    expect(firstHidden([100, 100, 100], 8, 315, 30)).toBe(2);
    expect(firstHidden([100, 100, 100], 8, 240, 30)).toBe(1);
  });

  it("hides everything when not even the first item fits beside the More button", () => {
    expect(firstHidden([100, 100], 8, 120, 30)).toBe(0);
  });
});
