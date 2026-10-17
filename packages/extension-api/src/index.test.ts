import { describe, expect, it } from "vitest";

describe("@openpaint/extension-api", () => {
  it("loads its entry module", async () => {
    await expect(import("./index")).resolves.toBeDefined();
  });
});
