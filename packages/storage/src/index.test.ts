import { describe, expect, it } from "vitest";

describe("@openpaint/storage", () => {
  it("loads its entry module", async () => {
    await expect(import("./index")).resolves.toBeDefined();
  });
});
