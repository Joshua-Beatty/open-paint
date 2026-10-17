import { describe, expect, it } from "vitest";

describe("@openpaint/properties", () => {
  it("loads its entry module", async () => {
    await expect(import("./index")).resolves.toBeDefined();
  });
});
