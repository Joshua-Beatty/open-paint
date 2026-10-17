import { DEFAULT_MEMORY_BUDGET_BYTES } from "@openpaint/document";
import { describe, expect, it } from "vitest";
import { documentBudgetBytes, TOUCH_DEVICE_BUDGET_BYTES } from "./memory-budget";

describe("documentBudgetBytes", () => {
  it("uses the reported device memory wherever there is one", () => {
    expect(documentBudgetBytes(4, true)).toBe(1024 ** 3);
    expect(documentBudgetBytes(8, false)).toBe(DEFAULT_MEMORY_BUDGET_BYTES);
  });

  it("keeps the default on a mouse device and lowers it on a touch device without a report", () => {
    expect(documentBudgetBytes(undefined, false)).toBe(DEFAULT_MEMORY_BUDGET_BYTES);
    expect(documentBudgetBytes(undefined, true)).toBe(TOUCH_DEVICE_BUDGET_BYTES);
  });
});
