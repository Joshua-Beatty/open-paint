/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { Document } from "./document";
import { rect } from "./geometry";
import { Selection } from "./selection";
import { rectPolygon } from "./selection-polygons";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

function cleanDocument(): Document {
  const doc = Document.createBlank({ width: 8, height: 6 });
  doc.markClean();
  return doc;
}

describe("Document selection commands (DOC-SEL-06)", () => {
  it("starts with nothing selected and the default antialiased quality", () => {
    const doc = cleanDocument();
    expect(doc.selection.isEmpty).toBe(true);
    expect(doc.selection.quality).toBe("antialiased");
  });

  it("Select All selects the canvas and marks the document dirty", () => {
    const doc = cleanDocument();
    doc.selectAll();
    expect(doc.selection.bounds()).toEqual(rect(0, 0, 8, 6));
    expect(doc.selection.area()).toBe(48);
    expect(doc.dirty).toBe(true);
  });

  it("Deselect clears the selection and keeps the quality", () => {
    const doc = cleanDocument();
    doc.setSelectionQuality("aliased");
    doc.selectAll();
    doc.deselect();
    expect(doc.selection.isEmpty).toBe(true);
    expect(doc.selection.quality).toBe("aliased");
  });

  it("Invert Selection is disabled when nothing is selected", () => {
    const doc = cleanDocument();
    expect(doc.invertSelection()).toBe(false);
    expect(doc.selection.isEmpty).toBe(true);
    expect(doc.dirty).toBe(false);
  });

  it("Invert Selection selects the canvas minus the current selection", () => {
    const doc = cleanDocument();
    doc.combineSelection([rectPolygon(rect(0, 0, 4, 6))], "replace");
    expect(doc.invertSelection()).toBe(true);
    expect(doc.selection.area()).toBe(24);
    expect(doc.selection.bounds()).toEqual(rect(4, 0, 4, 6));
  });

  it("combines a polygon set with the selection using the chosen mode", () => {
    const doc = cleanDocument();
    doc.combineSelection([rectPolygon(rect(0, 0, 4, 4))], "replace");
    doc.combineSelection([rectPolygon(rect(2, 0, 4, 4))], "union");
    expect(doc.selection.area()).toBe(24);
    doc.combineSelection([rectPolygon(rect(0, 0, 2, 2))], "exclude");
    expect(doc.selection.area()).toBe(20);
  });

  it("changes the quality and reports whether it changed", () => {
    const doc = cleanDocument();
    doc.selectAll();
    expect(doc.setSelectionQuality("aliased")).toBe(true);
    expect(doc.selection.quality).toBe("aliased");
    expect(doc.setSelectionQuality("aliased")).toBe(false);
  });

  it("keeps earlier selections valid after a command", () => {
    const doc = cleanDocument();
    doc.selectAll();
    const before = doc.selection;
    doc.deselect();
    expect(before).toBeInstanceOf(Selection);
    expect(before.area()).toBe(48);
  });

  it("notifies subscribers after selection changes", () => {
    const doc = cleanDocument();
    let calls = 0;
    const unsubscribe = doc.subscribe(() => {
      calls++;
    });
    doc.selectAll();
    doc.deselect();
    unsubscribe();
    doc.selectAll();
    expect(calls).toBe(2);
  });
});
