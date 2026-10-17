import { describe, expect, it } from "vitest";
import { filledIcon, iconShape } from "./icons";

describe("icon data", () => {
  it("reads plain path data as a stroked 16 x 16 outline", () => {
    expect(iconShape("M2 2h12")).toEqual({ viewBox: "0 0 16 16", path: "M2 2h12", filled: false });
  });

  it("reads a filled icon with its own grid", () => {
    const path = "M128,20A108,108,0,1,0,236,128Z";
    expect(iconShape(filledIcon(256, path))).toEqual({
      viewBox: "0 0 256 256",
      path,
      filled: true,
    });
    expect(iconShape(filledIcon(24, "M1 1H23V23Z")).viewBox).toBe("0 0 24 24");
  });
});
