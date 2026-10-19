// @vitest-environment node
/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document, MemorySpillStorage, SpillStore } from "@openpaint/document";
import type { ToolPointerEvent } from "@openpaint/extension-api";
import type { SettingChange } from "@openpaint/storage";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ColorSettings } from "../colors/use-colors";
import type { PaintHost } from "./paint-tools";
import { shapeToolRuntime } from "./shape-tools";
import { bindToolHistory, soloSwitcher } from "./tool-history";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/** A spill storage that counts the bytes it holds. */
class CountingStorage extends MemorySpillStorage {
  bytes = 0;
  readonly #sizes = new Map<string, number>();
  override async write(key: string, data: Uint8Array): Promise<void> {
    this.#sizes.set(key, data.length);
    this.bytes += data.length;
    await super.write(key, data);
  }
  override async remove(key: string): Promise<void> {
    this.bytes -= this.#sizes.get(key) ?? 0;
    this.#sizes.delete(key);
    await super.remove(key);
  }
}

class FakeSettings {
  readonly values: Record<string, unknown> = {
    "tools.primaryColor": { r: 0, g: 0, b: 0, a: 255 },
    "tools.secondaryColor": { r: 255, g: 255, b: 255, a: 255 },
    "tools.brush.size": 6,
    "tools.antialiasing": true,
    "tools.shapes.shape": { name: "ellipse" },
    "tools.shapes.drawType": "Outline",
  };
  readonly #listeners = new Set<(change: SettingChange) => void>();
  get = (path: string): unknown => this.values[path];
  set = (path: string, value: unknown): void => {
    this.values[path] = value;
    for (const listener of this.#listeners) {
      listener({ path, value: value as SettingChange["value"], source: "local" });
    }
  };
  onChange = (listener: (change: SettingChange) => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
}

function event(type: ToolPointerEvent["type"], x: number, y: number): ToolPointerEvent {
  return { type, x, y, button: 0, pressure: 1, shiftKey: false, altKey: false, ctrlKey: false };
}

/**
 * The history memory of a 50-edit shape session on a 4000 x 3000 image (owner request): the bytes
 * its items keep, as the spill store writes them (LZ4) and raw.
 */
describe("history memory of a pending shape (owner request)", () => {
  it("measures a 50-edit ellipse session", { timeout: 120_000 }, async () => {
    const storage = new CountingStorage();
    const spill = new SpillStore({ storage, cacheBytes: 0 });
    const doc = Document.createBlank({ width: 4000, height: 3000, spill });
    const raw = vi.spyOn(spill, "put");
    const settings = new FakeSettings();
    const host: PaintHost = {
      settings: () => settings as unknown as ColorSettings,
      document: () => doc,
      translate: (id) => id,
      notify: () => undefined,
      report: () => undefined,
    };
    const runtime = shapeToolRuntime(host);
    runtime.activate();
    bindToolHistory(doc, soloSwitcher("shapes", runtime));
    runtime.pointer(event("down", 500, 500));
    runtime.pointer(event("move", 3500, 2500));
    runtime.pointer(event("up", 3500, 2500));
    await spill.flush();
    const afterDraw = storage.bytes;
    const rawAfterDraw = raw.mock.results.reduce(
      (sum, r) => sum + (r.value as { rawBytes: number }).rawBytes,
      0,
    );
    for (let i = 0; i < 50; i++) {
      // A body drag of 7 px each time.
      runtime.pointer(event("down", 2000 + i * 7, 1500));
      runtime.pointer(event("move", 2007 + i * 7, 1500));
      runtime.pointer(event("up", 2007 + i * 7, 1500));
    }
    await spill.flush();
    const rawTotal = raw.mock.results.reduce(
      (sum, r) => sum + (r.value as { rawBytes: number }).rawBytes,
      0,
    );
    expect(doc.history.entries.length).toBe(52);
    process.stderr.write(
      `HISTORY-MEMORY draw: ${afterDraw} B stored (${rawAfterDraw} B raw); 50 edits: ${
        storage.bytes - afterDraw
      } B stored (${rawTotal - rawAfterDraw} B raw); per edit ${Math.round(
        (storage.bytes - afterDraw) / 50,
      )} B stored (${Math.round((rawTotal - rawAfterDraw) / 50)} B raw)\n`,
    );
    // The steps keep only the shape's state: no pixels (before the overlay: about 290 KB stored,
    // 21 MB raw, per step).
    expect(rawTotal).toBe(0);
    runtime.commit?.();
    await spill.flush();
    // Finish keeps only the pixels it overwrote: one tile patch of the outline's tiles.
    const finish = raw.mock.results.at(-1)?.value as { rawBytes: number } | undefined;
    expect(raw.mock.results).toHaveLength(1);
    expect(finish?.rawBytes).toBeLessThan(12 * 1024 * 1024);
    runtime.deactivate();
  });
});
