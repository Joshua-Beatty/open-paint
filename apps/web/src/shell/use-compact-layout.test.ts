import { describe, expect, it } from "vitest";
import { compactLayoutFor, DESKTOP_LAYOUT } from "./use-compact-layout";

describe("compactLayoutFor", () => {
  it("keeps the desktop layout from 1024 x 600 up", () => {
    expect(compactLayoutFor(1024, 600)).toBe(DESKTOP_LAYOUT);
    expect(compactLayoutFor(1280, 720)).toBe(DESKTOP_LAYOUT);
    expect(compactLayoutFor(1180, 820)).toBe(DESKTOP_LAYOUT);
  });

  it("is compact on phones and small tablets, one row when short, a side sheet when wide", () => {
    expect(compactLayoutFor(390, 844)).toEqual({ compact: true, short: false, sideSheet: false });
    expect(compactLayoutFor(844, 390)).toEqual({ compact: true, short: true, sideSheet: true });
    expect(compactLayoutFor(768, 1024)).toEqual({ compact: true, short: false, sideSheet: true });
    expect(compactLayoutFor(1366, 560)).toEqual({ compact: true, short: false, sideSheet: true });
  });
});
