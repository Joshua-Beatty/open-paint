import { describe, expect, it } from "vitest";
import { NAVIGATION_QUIET_MS, navigating, noteViewInput, setViewDragging } from "./navigation";

describe("navigating (L5)", () => {
  it("holds while a pan drag is held and briefly after any view input", () => {
    setViewDragging(true, 1000);
    expect(navigating(5000)).toBe(true);
    setViewDragging(false, 6000);
    expect(navigating(6000 + NAVIGATION_QUIET_MS - 1)).toBe(true);
    expect(navigating(6000 + NAVIGATION_QUIET_MS)).toBe(false);
    noteViewInput(9000);
    expect(navigating(9100)).toBe(true);
    expect(navigating(9000 + NAVIGATION_QUIET_MS)).toBe(false);
  });
});
