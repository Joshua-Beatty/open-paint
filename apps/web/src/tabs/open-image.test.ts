/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document } from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import { hasUnsavedWork, isBlankImage, type OpenImage } from "./open-image";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const untitled = "Untitled";

function blank(name = untitled): OpenImage {
  return { name, document: Document.createBlank({ width: 8, height: 6 }) };
}

describe("isBlankImage and hasUnsavedWork (owner request)", () => {
  it("treats a new untitled image as blank and not unsaved", () => {
    const image = blank();
    expect(isBlankImage(image, untitled)).toBe(true);
    expect(hasUnsavedWork(image, untitled)).toBe(false);
  });

  it("does not count a selection on a blank image as unsaved work", () => {
    const image = blank();
    image.document.selectAll();
    expect(image.document.dirty).toBe(true);
    expect(isBlankImage(image, untitled)).toBe(true);
    expect(hasUnsavedWork(image, untitled)).toBe(false);
  });

  it("does not count an undone edit as unsaved work", async () => {
    const image = blank();
    image.document.addLayer();
    expect(hasUnsavedWork(image, untitled)).toBe(true);
    await image.document.history.undo();
    expect(hasUnsavedWork(image, untitled)).toBe(false);
  });

  it("counts a real edit as unsaved work", () => {
    const image = blank();
    image.document.addLayer();
    expect(isBlankImage(image, untitled)).toBe(false);
    expect(hasUnsavedWork(image, untitled)).toBe(true);
  });

  it("counts a selection on an image with another name or a file as unsaved work", () => {
    const named = blank("Sketch");
    named.document.selectAll();
    expect(isBlankImage(named, untitled)).toBe(false);
    expect(hasUnsavedWork(named, untitled)).toBe(true);
    const filed: OpenImage = { ...blank(), file: { typeId: "png" } };
    filed.document.selectAll();
    expect(isBlankImage(filed, untitled)).toBe(false);
    expect(hasUnsavedWork(filed, untitled)).toBe(true);
  });

  it("is never unsaved work while the document is clean", () => {
    const named = blank("Sketch");
    expect(isBlankImage(named, untitled)).toBe(false);
    expect(hasUnsavedWork(named, untitled)).toBe(false);
  });
});
