// @vitest-environment node
import { builtinFileTypeRegistry } from "@openpaint/codecs";
import { openFileTypes } from "@openpaint/extension-api";
import { describe, expect, it } from "vitest";
import { FILE_HANDLER_ACCEPT } from "./file-handlers";

describe("PWA file handlers (FMT-SHELL-02)", () => {
  const types = openFileTypes(
    builtinFileTypeRegistry({ embedBmpColorProfiles: () => false, memoryBudgetBytes: () => 1 }),
  );

  it("accepts every extension and MIME type of the built-in open types", () => {
    const extensions = [...new Set(types.flatMap((type) => type.loadExtensions))].sort();
    const mimeTypes = [...new Set(types.flatMap((type) => type.mimeTypes))].sort();

    expect(Object.values(FILE_HANDLER_ACCEPT).flat().sort()).toEqual(extensions);
    expect(Object.keys(FILE_HANDLER_ACCEPT).sort()).toEqual(mimeTypes);
  });

  it("pairs each type's extensions with its own MIME type", () => {
    for (const type of types) {
      for (const mime of type.mimeTypes) {
        expect(FILE_HANDLER_ACCEPT[mime]).toEqual(expect.arrayContaining([...type.loadExtensions]));
      }
    }
  });
});
