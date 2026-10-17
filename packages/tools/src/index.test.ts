import { describe, expect, it } from "vitest";

describe("@openpaint/tools", () => {
  it("loads its entry module", async () => {
    await expect(import("./index")).resolves.toBeDefined();
  });
});
