import { describe, expect, it } from "vitest";
import {
  allocateWithBudget,
  DEFAULT_MEMORY_BUDGET_BYTES,
  MemoryAccountant,
  OutOfMemoryError,
} from "./memory";

describe("MemoryAccountant", () => {
  it("defaults to a 2 GiB budget", () => {
    expect(new MemoryAccountant().budgetBytes).toBe(DEFAULT_MEMORY_BUDGET_BYTES);
    expect(DEFAULT_MEMORY_BUDGET_BYTES).toBe(2_147_483_648);
  });

  it("reserves and releases within the budget", () => {
    const m = new MemoryAccountant(100);
    m.reserve(60);
    expect(m.usedBytes).toBe(60);
    expect(m.availableBytes).toBe(40);
    expect(m.canReserve(41)).toBe(false);
    expect(() => m.reserve(41)).toThrow(OutOfMemoryError);
    expect(m.usedBytes).toBe(60);
    m.release(60);
    expect(m.usedBytes).toBe(0);
    expect(() => m.release(1)).toThrow(RangeError);
    expect(() => m.reserve(-1)).toThrow(RangeError);
  });

  it("reports the request in OutOfMemoryError", () => {
    const m = new MemoryAccountant(10);
    try {
      m.reserve(11);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(OutOfMemoryError);
      expect((e as OutOfMemoryError).requestedBytes).toBe(11);
      expect((e as OutOfMemoryError).availableBytes).toBe(10);
    }
  });

  it("releases the reservation when the allocation itself fails", () => {
    const m = new MemoryAccountant(100);
    expect(() =>
      allocateWithBudget(m, 50, () => {
        throw new RangeError("Array buffer allocation failed");
      }),
    ).toThrow(OutOfMemoryError);
    expect(m.usedBytes).toBe(0);
    expect(allocateWithBudget(m, 50, () => "ok")).toBe("ok");
    expect(m.usedBytes).toBe(50);
  });
});
