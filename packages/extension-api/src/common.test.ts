import { describe, expect, it } from "vitest";
import { throwIfCancelRequested } from "./common";
import { EXTENSION_API_MAJOR, EXTENSION_API_VERSION } from "./version";

describe("throwIfCancelRequested", () => {
  it("does nothing while the job is not canceled", () => {
    expect(() => throwIfCancelRequested({ isCancelRequested: false })).not.toThrow();
  });

  it("throws the operation canceled error once cancellation is requested (EXT-03-08)", () => {
    expect(() => throwIfCancelRequested({ isCancelRequested: true })).toThrow("operation canceled");
  });
});

describe("extension API version", () => {
  it("has a semantic version whose major part matches the descriptor version", () => {
    expect(EXTENSION_API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(EXTENSION_API_VERSION.split(".")[0]).toBe(String(EXTENSION_API_MAJOR));
  });
});
