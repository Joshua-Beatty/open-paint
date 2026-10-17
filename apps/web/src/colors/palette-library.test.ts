import { describe, expect, it, vi } from "vitest";
import { type Rgba, WHITE } from "./color-math";
import { serializePalette } from "./palette";
import {
  deletePalette,
  importPalettes,
  memoryPaletteStorage,
  paletteNames,
  readPalette,
  renamePalette,
  savePalette,
} from "./palette-library";

const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 };
const GREEN: Rgba = { r: 0, g: 255, b: 0, a: 255 };

function noReplace() {
  return vi.fn(async (_name: string) => false);
}

function yesReplace() {
  return vi.fn(async (_name: string) => true);
}

describe("palette storage rules", () => {
  it("saves a new palette without asking", async () => {
    const storage = memoryPaletteStorage();
    const confirm = noReplace();
    expect(await savePalette(storage, " Sky ", [RED], confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(await paletteNames(storage)).toEqual(["Sky"]);
    expect((await readPalette(storage, "Sky"))?.[0]).toEqual(RED);
  });

  it("asks before replacing a palette, and keeps it when the answer is no", async () => {
    const storage = memoryPaletteStorage();
    await savePalette(storage, "Sky", [RED], yesReplace());
    const confirm = noReplace();
    expect(await savePalette(storage, "Sky", [GREEN], confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledWith("Sky");
    expect((await readPalette(storage, "Sky"))?.[0]).toEqual(RED);
  });

  it("replaces a palette when the answer is yes", async () => {
    const storage = memoryPaletteStorage();
    await savePalette(storage, "Sky", [RED], yesReplace());
    expect(await savePalette(storage, "Sky", [GREEN], yesReplace())).toBe(true);
    expect((await readPalette(storage, "Sky"))?.[0]).toEqual(GREEN);
  });

  it("refuses an invalid name without asking", async () => {
    const storage = memoryPaletteStorage();
    const confirm = yesReplace();
    expect(await savePalette(storage, "a/b", [RED], confirm)).toBe(false);
    expect(await savePalette(storage, "   ", [RED], confirm)).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(await paletteNames(storage)).toEqual([]);
  });

  it("renames a palette and removes the old name", async () => {
    const storage = memoryPaletteStorage();
    await savePalette(storage, "Sky", [RED], yesReplace());
    expect(await renamePalette(storage, "Sky", "Dusk", noReplace())).toBe(true);
    expect(await paletteNames(storage)).toEqual(["Dusk"]);
    expect((await readPalette(storage, "Dusk"))?.[0]).toEqual(RED);
  });

  it("leaves both palettes alone when a rename would replace and is declined", async () => {
    const storage = memoryPaletteStorage();
    await savePalette(storage, "Sky", [RED], yesReplace());
    await savePalette(storage, "Dusk", [GREEN], yesReplace());
    expect(await renamePalette(storage, "Sky", "Dusk", noReplace())).toBe(false);
    expect(await paletteNames(storage)).toEqual(["Dusk", "Sky"]);
    expect((await readPalette(storage, "Dusk"))?.[0]).toEqual(GREEN);
  });

  it("fails to rename a palette that does not exist, and treats the same name as done", async () => {
    const storage = memoryPaletteStorage();
    expect(await renamePalette(storage, "Missing", "Dusk", yesReplace())).toBe(false);
    await savePalette(storage, "Sky", [RED], yesReplace());
    expect(await renamePalette(storage, "Sky", "Sky", noReplace())).toBe(true);
  });

  it("deletes a palette, and deleting a missing one does nothing", async () => {
    const storage = memoryPaletteStorage({ Sky: serializePalette([RED]) });
    await deletePalette(storage, "Sky");
    await deletePalette(storage, "Sky");
    expect(await paletteNames(storage)).toEqual([]);
  });

  it("lists names in name order", async () => {
    const storage = memoryPaletteStorage({ dusk: "", Sky: "", Ash: "" });
    expect(await paletteNames(storage)).toEqual(["Ash", "dusk", "Sky"]);
  });

  it("reads a palette as 96 colors, or undefined when it is missing", async () => {
    const storage = memoryPaletteStorage({ Sky: serializePalette([RED]) });
    const colors = await readPalette(storage, "Sky");
    expect(colors).toHaveLength(96);
    expect(colors?.[1]).toEqual(WHITE);
    expect(await readPalette(storage, "Missing")).toBeUndefined();
  });
});

describe("palette import", () => {
  it("copies each palette file under its name without the extension", async () => {
    const storage = memoryPaletteStorage();
    const imported = await importPalettes(
      storage,
      [{ fileName: "Ocean.txt", text: "FF0000FF\n" }],
      noReplace(),
    );
    expect(imported).toEqual(["Ocean"]);
    const colors = await readPalette(storage, "Ocean");
    expect(colors?.[0]).toEqual({ r: 0, g: 0, b: 255, a: 255 });
    expect(colors).toHaveLength(96);
  });

  it("skips a name in use when the replacement is declined, and replaces it when accepted", async () => {
    const storage = memoryPaletteStorage({ Ocean: serializePalette([RED]) });
    const declined = await importPalettes(
      storage,
      [{ fileName: "Ocean.txt", text: "FF0000FF" }],
      noReplace(),
    );
    expect(declined).toEqual([]);
    expect((await readPalette(storage, "Ocean"))?.[0]).toEqual(RED);
    const accepted = await importPalettes(
      storage,
      [{ fileName: "Ocean.txt", text: "FF0000FF" }],
      yesReplace(),
    );
    expect(accepted).toEqual(["Ocean"]);
    expect((await readPalette(storage, "Ocean"))?.[0]).toEqual({ r: 0, g: 0, b: 255, a: 255 });
  });

  it("asks for each conflicting file in turn", async () => {
    const storage = memoryPaletteStorage({ A: serializePalette([RED]) });
    const confirm = noReplace();
    const imported = await importPalettes(
      storage,
      [
        { fileName: "A.txt", text: "" },
        { fileName: "B.txt", text: "" },
      ],
      confirm,
    );
    expect(imported).toEqual(["B"]);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("skips files with names that cannot be saved", async () => {
    const storage = memoryPaletteStorage();
    const imported = await importPalettes(storage, [{ fileName: ".txt", text: "" }], noReplace());
    expect(imported).toEqual([]);
    expect(await paletteNames(storage)).toEqual([]);
  });
});
