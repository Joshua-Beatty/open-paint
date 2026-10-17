import { describe, expect, it } from "vitest";
import { NO_TILE, slotCode } from "./tile-allocator";
import { type StackLayer, TileTable } from "./tile-table";

const layer = (id: number, patch: Partial<StackLayer> = {}): StackLayer => ({
  id,
  visible: true,
  opacity: 255,
  mode: 0,
  ...patch,
});

describe("TileTable", () => {
  it("builds the slot grid and blending of the active layers only", () => {
    const table = new TileTable(600, 300);
    expect([table.tilesX, table.tilesY]).toEqual([3, 2]);
    table.setStack([layer(1), layer(2, { visible: false }), layer(3, { mode: 2, opacity: 7 })]);
    table.setTile(1, 2, 1, slotCode(0, 4));
    table.setTile(3, 0, 0, slotCode(1, 0));

    const built = table.build();
    expect(built.layers).toEqual(new Uint32Array([0, 0, 255, 0, 6, 2, 7, 0]));
    expect(built.table[5]).toBe(slotCode(0, 4));
    expect(built.table[6]).toBe(slotCode(1, 0));
    expect(built.table.filter((code) => code !== NO_TILE)).toHaveLength(2);
    expect(built.pages.map((pages) => [...pages])).toEqual([[0], [1]]);
    expect(table.build()).toBe(built);
  });

  it("keeps tiles by layer id across stack changes and frees the removed layers", () => {
    const table = new TileTable(256, 256);
    table.setStack([layer(1), layer(2)]);
    table.setTile(1, 0, 0, 11);
    table.setTile(2, 0, 0, 22);

    const reorder = table.setStack([layer(2), layer(1, { opacity: 3 })]);
    expect(reorder).toEqual({ freed: [], changed: true });
    expect(table.tile(1, 0, 0)).toBe(11);

    const removal = table.setStack([layer(1, { opacity: 3 })]);
    expect(removal).toEqual({ freed: [22], changed: true });
    expect(table.setStack([layer(1, { opacity: 3 })]).changed).toBe(false);
  });

  it("shows overrides over committed tiles until they are cleared", () => {
    const table = new TileTable(512, 256);
    table.setStack([layer(1)]);
    table.setTile(1, 0, 0, slotCode(0, 1));
    table.setOverride(1, 0, 0, slotCode(2, 9));
    table.setOverride(1, 1, 0, slotCode(2, 10));
    expect([...table.build().table]).toEqual([slotCode(2, 9), slotCode(2, 10)]);
    expect([...(table.build().pages[0] ?? [])].sort()).toEqual([0, 2]);

    const cleared = table.clearOverrides(1);
    expect([...cleared.entries()]).toEqual([
      [0, slotCode(2, 9)],
      [1, slotCode(2, 10)],
    ]);
    expect([...table.build().table]).toEqual([slotCode(0, 1), NO_TILE]);
    expect([...(table.build().pages[0] ?? [])]).toEqual([0]);
  });

  it("returns the replaced slot when a tile changes and refuses unknown layers", () => {
    const table = new TileTable(256, 256);
    table.setStack([layer(1)]);
    expect(table.setTile(1, 0, 0, 5)).toBeUndefined();
    expect(table.setTile(1, 0, 0, 6)).toBe(5);
    expect(table.setTile(1, 0, 0, undefined)).toBe(6);
    expect(table.allCodes()).toEqual([]);
    expect(() => table.setTile(4, 0, 0, 1)).toThrow("Layer 4");
  });
});
