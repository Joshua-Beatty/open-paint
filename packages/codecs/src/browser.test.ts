// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { browserClipboard, browserCodecs, type ClipboardItemClass } from "./browser";
import { encodePngAsync } from "./png";
import { deflateZlib } from "./zlib";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

const PIXELS = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 255]);

describe("browserCodecs clipboard decoding (WEB-FILE-07)", () => {
  it("decodes PNG clipboard data in WASM to the same straight RGBA pixels", async () => {
    const png = await encodePngAsync({ width: 2, height: 2, data: PIXELS }, deflateZlib);
    const blob = new Blob([png.slice()], { type: "image/png" });

    const surface = await browserCodecs().decodeImage(blob);

    expect(surface).toBeDefined();
    expect(surface?.width).toBe(2);
    expect(surface?.height).toBe(2);
    expect([...(surface?.data ?? [])]).toEqual([...PIXELS]);
  });

  it("rejects PNG bytes that do not decode", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    await expect(browserCodecs().decodeImage(blob)).rejects.toThrow();
  });
});

describe("browserClipboard writes (WEB-CLIP-01)", () => {
  const entries = {
    "image/png": new Blob(["png"], { type: "image/png" }),
    "web application/x-openpaint-selection+json": new Blob(["{}"], { type: "text/plain" }),
  };

  function recorder() {
    const written: string[][] = [];
    const clipboard = {
      write: async (items: { types: string[] }[]) => {
        for (const item of items) written.push(item.types);
      },
    } as unknown as Clipboard;
    return { written, clipboard };
  }

  /** A `ClipboardItem` that, like Firefox's, rejects custom `web ` types. */
  class StandardItem {
    readonly types: string[];
    constructor(items: Record<string, Blob>) {
      this.types = Object.keys(items);
      if (this.types.some((type) => type.startsWith("web ")))
        throw new TypeError("not a valid type");
    }
  }

  it("leaves out the types ClipboardItem.supports rejects", async () => {
    const { written, clipboard } = recorder();
    const Item = Object.assign(StandardItem, {
      supports: (type: string) => !type.startsWith("web "),
    });
    await browserClipboard(clipboard, Item as unknown as ClipboardItemClass).write(entries);
    expect(written).toEqual([["image/png"]]);
  });

  it("writes again without the custom types when the item is rejected", async () => {
    const { written, clipboard } = recorder();
    await browserClipboard(clipboard, StandardItem as unknown as ClipboardItemClass).write(entries);
    expect(written).toEqual([["image/png"]]);
  });

  it("keeps the custom types where the browser accepts them", async () => {
    const { written, clipboard } = recorder();
    class AnyItem {
      readonly types: string[];
      constructor(items: Record<string, Blob>) {
        this.types = Object.keys(items);
      }
    }
    await browserClipboard(clipboard, AnyItem as unknown as ClipboardItemClass).write(entries);
    expect(written).toEqual([Object.keys(entries)]);
  });
});
