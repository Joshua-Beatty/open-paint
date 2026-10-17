import { describe, expect, it } from "vitest";

describe("@openpaint/codecs", () => {
  it("loads its entry module", async () => {
    await expect(import("./index")).resolves.toBeDefined();
  });
});
