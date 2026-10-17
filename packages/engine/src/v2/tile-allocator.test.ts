import { describe, expect, it } from "vitest";
import { slotCode, slotPage, slotSlice, TileAllocator } from "./tile-allocator";

describe("TileAllocator", () => {
  it("encodes a page and slice in one slot code", () => {
    const code = slotCode(3, 1023);
    expect(slotPage(code)).toBe(3);
    expect(slotSlice(code)).toBe(1023);
  });

  it("grows a page by doubling and opens a new page when one is full", () => {
    const allocator = new TileAllocator(8, 2);
    const codes = Array.from({ length: 9 }, () => allocator.allocate());
    expect(codes.slice(0, 8).map(slotPage)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(allocator.capacity(0)).toBe(8);
    expect(slotPage(codes[8] as number)).toBe(1);
    expect(allocator.capacity(1)).toBe(2);
    expect(allocator.used).toBe(9);
  });

  it("reuses freed slices and prefers the requested page", () => {
    const allocator = new TileAllocator(2, 2);
    const a = allocator.allocate();
    allocator.allocate();
    const c = allocator.allocate();
    expect(slotPage(c)).toBe(1);
    allocator.free(a);
    expect(allocator.allocate(1)).toBe(slotCode(1, 1));
    expect(allocator.allocate()).toBe(a);
    expect(() => allocator.free(slotCode(0, 5))).toThrow("not in use");
  });

  it("forgets every slot on reset but keeps the capacities", () => {
    const allocator = new TileAllocator(16, 4);
    for (let i = 0; i < 6; i++) allocator.allocate();
    allocator.reset();
    expect(allocator.used).toBe(0);
    expect(allocator.capacity(0)).toBe(8);
    expect(allocator.allocate()).toBe(slotCode(0, 0));
  });
});
