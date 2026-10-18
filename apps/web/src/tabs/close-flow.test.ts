/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document } from "@openpaint/document";
import { beforeAll, describe, expect, it } from "vitest";
import { closeCandidates, hasUnsavedImages, planClose } from "./close-flow";
import type { ImageTab } from "./image-tabs";
import type { OpenImage } from "./open-image";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

describe("planClose", () => {
  it("lists every image in tab order and the unsaved ones among them", () => {
    const plan = planClose([
      { id: "a", dirty: false },
      { id: "b", dirty: true },
      { id: "c", dirty: true },
    ]);
    expect(plan.ids).toEqual(["a", "b", "c"]);
    expect(plan.dirty).toEqual(["b", "c"]);
  });

  it("has no unsaved images when every candidate is clean", () => {
    expect(planClose([{ id: "a", dirty: false }]).dirty).toEqual([]);
    expect(planClose([]).ids).toEqual([]);
  });
});

describe("hasUnsavedImages", () => {
  it("is true while any image is dirty", () => {
    expect(hasUnsavedImages([{ id: "a", dirty: false }])).toBe(false);
    expect(
      hasUnsavedImages([
        { id: "a", dirty: false },
        { id: "b", dirty: true },
      ]),
    ).toBe(true);
    expect(hasUnsavedImages([])).toBe(false);
  });
});

describe("closeCandidates (owner request)", () => {
  function tab(id: string, name: string): ImageTab<OpenImage> {
    return { id, value: { name, document: Document.createBlank({ width: 4, height: 4 }) } };
  }

  it("leaves a blank untitled image with only a selection out of the prompts", () => {
    const blank = tab("a", "Untitled");
    blank.value.document.selectAll();
    const drawn = tab("b", "Untitled");
    drawn.value.document.addLayer();
    const candidates = closeCandidates([blank, drawn], "Untitled");
    expect(candidates).toEqual([
      { id: "a", dirty: false },
      { id: "b", dirty: true },
    ]);
    expect(planClose(candidates).dirty).toEqual(["b"]);
    expect(hasUnsavedImages(closeCandidates([blank], "Untitled"))).toBe(false);
  });
});
