import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { Document, MemoryAccountant, rect } from "@openpaint/document";
import type { SessionCheckpoint, SessionStore } from "@openpaint/storage";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenImage } from "../tabs/open-image";
import { SessionRecovery, type SessionRecoveryOptions } from "./session-recovery";

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/** A session store in memory, keyed by owner and key. */
class MemorySessionStore implements SessionStore {
  readonly entries = new Map<string, SessionCheckpoint>();
  readonly writes: SessionCheckpoint[] = [];
  failWrites = false;

  async write(owner: string, key: string, checkpoint: SessionCheckpoint): Promise<void> {
    if (this.failWrites) throw new Error("quota exceeded");
    this.writes.push(checkpoint);
    const previous = this.entries.get(`${owner}/${key}`)?.blobs;
    const blobs = new Map(checkpoint.blobs);
    for (const name of checkpoint.retained ?? []) {
      const kept = previous?.get(name);
      if (kept === undefined) throw new Error(`retained blob ${name} was never written`);
      blobs.set(name, kept);
    }
    this.entries.set(`${owner}/${key}`, { document: checkpoint.document, blobs });
  }

  async read(owner: string, key: string): Promise<SessionCheckpoint> {
    const found = this.entries.get(`${owner}/${key}`);
    if (found === undefined) throw new Error("missing checkpoint");
    return found;
  }

  async remove(owner: string, key: string): Promise<void> {
    this.entries.delete(`${owner}/${key}`);
  }

  async list(): Promise<{ owner: string; key: string }[]> {
    return [...this.entries.keys()].map((entry) => {
      const [owner = "", key = ""] = entry.split("/");
      return { owner, key };
    });
  }
}

function recovery(
  store: SessionStore,
  owner: string,
  options: Partial<SessionRecoveryOptions> = {},
): SessionRecovery {
  return new SessionRecovery({
    store,
    owner,
    liveOwners: async () => new Set<string>(),
    accountant: () => new MemoryAccountant(),
    persist: async () => true,
    onError: () => undefined,
    delayMs: 60_000,
    ...options,
  });
}

function editedImage(name: string): OpenImage {
  const document = Document.createBlank({ width: 12, height: 10 });
  const ink = document.addLayer();
  document.setActiveLayerProperties({ name: "Ink" });
  document.editLayerPixels("Brush", ink, rect(0, 0, 6, 6), (pixels) => {
    pixels.fill({ r: 255, g: 0, b: 0, a: 255 }, rect(0, 0, 6, 6));
  });
  return { name, document };
}

describe("SessionRecovery (WEB-MEM-05, SET-LIFE-11)", () => {
  it("offers checkpoints of instances that are gone and of this instance, not live ones", async () => {
    const store = new MemorySessionStore();
    const earlier = recovery(store, "earlier");
    await earlier.begin();
    earlier.track("1", editedImage("Gone"), "a");
    await earlier.flush();

    const live = recovery(store, "other");
    await live.begin();
    live.track("1", editedImage("Live"), "b");
    await live.flush();

    const current = recovery(store, "current", { liveOwners: async () => new Set(["other"]) });
    const offers = await current.begin();
    expect(offers.map((offer) => offer.name)).toEqual(["Gone"]);
  });

  it("offers nothing from other instances when the Web Locks API is missing", async () => {
    const store = new MemorySessionStore();
    const earlier = recovery(store, "earlier");
    await earlier.begin();
    earlier.track("1", editedImage("Gone"), "a");
    await earlier.flush();
    const current = recovery(store, "current", { liveOwners: async () => "all" });
    expect(await current.begin()).toEqual([]);
  });

  it("writes only the blobs that changed since the last checkpoint (L2)", async () => {
    const store = new MemorySessionStore();
    const image = editedImage("Sketch");
    const session = recovery(store, "self");
    await session.begin();
    session.track("1", image, "k");
    await session.flush();
    const first = store.writes.at(-1);
    expect(first?.retained).toEqual([]);

    const ink = image.document.activeLayer;
    if (ink === undefined) throw new Error("no active layer");
    image.document.editLayerPixels("Brush", ink, rect(0, 0, 2, 2), (pixels) => {
      pixels.fill({ r: 0, g: 0, b: 255, a: 255 }, rect(0, 0, 2, 2));
    });
    await session.flush();
    const second = store.writes.at(-1);
    const layers = [...(second?.blobs.keys() ?? [])].filter((name) => name.startsWith("layer-"));
    expect(layers).toHaveLength(1);
    expect(second?.retained?.length).toBeGreaterThan(0);

    const reader = recovery(store, "reader", { liveOwners: async () => new Set() });
    const [offer] = await reader.begin();
    if (offer === undefined) throw new Error("no offer");
    const restored = await reader.restore(offer);
    expect(restored.document.composite().data).toEqual(image.document.composite().data);
  });

  it("writes nothing until the offers are fixed", async () => {
    const store = new MemorySessionStore();
    const session = recovery(store, "self");
    session.track("1", editedImage("Sketch"), "k");
    await session.flush();
    expect(store.entries.size).toBe(0);

    await session.begin();
    await session.flush();
    expect(store.entries.size).toBe(1);
  });

  it("restores an offer with its history and unsaved state, and moves its checkpoint", async () => {
    const store = new MemorySessionStore();
    const image = editedImage("Sketch");
    const earlier = recovery(store, "earlier");
    await earlier.begin();
    earlier.track("1", image, "a");
    await earlier.flush();

    const current = recovery(store, "current");
    const [offer] = await current.begin();
    if (offer === undefined) throw new Error("no offer");
    const restored = await current.restore(offer);

    expect(restored.name).toBe("Sketch");
    expect(restored.document.dirty).toBe(true);
    expect(restored.document.history.entries).toEqual(image.document.history.entries);
    expect(restored.document.composite().data).toEqual(image.document.composite().data);
    expect([...store.entries.keys()]).toEqual([`current/${restored.key}`]);
  });

  it("discards offers by deleting their checkpoints", async () => {
    const store = new MemorySessionStore();
    const earlier = recovery(store, "earlier");
    await earlier.begin();
    earlier.track("1", editedImage("Sketch"), "a");
    await earlier.flush();

    const current = recovery(store, "current");
    const offers = await current.begin();
    await current.discard(offers);
    expect(store.entries.size).toBe(0);
  });

  it("does not offer a checkpoint it cannot read", async () => {
    const store = new MemorySessionStore();
    store.entries.set("earlier/broken", { document: {}, blobs: new Map() });
    const current = recovery(store, "current");
    expect(await current.begin()).toEqual([]);
  });

  it("checkpoints a change after the delay, and deletes the checkpoint when untracked", async () => {
    const store = new MemorySessionStore();
    const session = recovery(store, "self", { delayMs: 5 });
    await session.begin();
    const image = editedImage("Sketch");
    session.track("1", image, "k");
    await vi.waitFor(() => expect(store.entries.size).toBe(1));

    image.document.addLayer();
    await vi.waitFor(() => {
      const saved = store.entries.get("self/k")?.document as
        | { manifest: { layers: unknown[] } }
        | undefined;
      expect(saved?.manifest.layers).toHaveLength(3);
    });

    session.untrack("1");
    await vi.waitFor(() => expect(store.entries.size).toBe(0));
  });

  it("waits for an interactive edit to end before a scheduled checkpoint", async () => {
    const store = new MemorySessionStore();
    let interacting = true;
    const session = recovery(store, "self", { delayMs: 5, interacting: () => interacting });
    await session.begin();
    const image = editedImage("Sketch");
    const ink = image.document.activeLayer;
    if (ink === undefined) throw new Error("no layer");
    session.track("1", image, "k");
    // A stroke's preview notifies the document without a history item.
    image.document.previewLayerPixels(ink, (pixels) => {
      pixels.fill({ r: 0, g: 0, b: 255, a: 255 }, rect(8, 0, 2, 2));
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(store.entries.size).toBe(0);
    expect(session.saving).toBe(false);

    interacting = false;
    await vi.waitFor(() => expect(store.entries.size).toBe(1));
  });

  it("flushes at once, even during an interactive edit", async () => {
    const store = new MemorySessionStore();
    const session = recovery(store, "self", { interacting: () => true });
    await session.begin();
    session.track("1", editedImage("Sketch"), "k");
    await session.flush();
    expect(store.entries.size).toBe(1);
  });

  it("reports saving while a checkpoint is written, and holds no lock on the document", async () => {
    let finish: (() => void) | undefined;
    const store = new MemorySessionStore();
    const write = store.write.bind(store);
    store.write = async (owner, key, checkpoint) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await write(owner, key, checkpoint);
    };
    const session = recovery(store, "self");
    await session.begin();
    const image = editedImage("Sketch");
    const ink = image.document.activeLayer;
    if (ink === undefined) throw new Error("no layer");
    session.track("1", image, "k");
    const flushed = session.flush();
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(session.saving).toBe(true);

    image.document.previewLayerPixels(ink, (pixels) => {
      pixels.fill({ r: 0, g: 0, b: 255, a: 255 }, rect(8, 0, 2, 2));
    });
    image.document.editLayerPixels("Brush", ink, rect(8, 0, 2, 2), () => undefined);
    finish?.();
    await flushed;
    expect(session.saving).toBe(false);
  });

  it("reports a failed write without losing the image", async () => {
    const store = new MemorySessionStore();
    store.failWrites = true;
    const errors: unknown[] = [];
    const session = recovery(store, "self", { onError: (error) => errors.push(error) });
    await session.begin();
    session.track("1", editedImage("Sketch"), "k");
    await session.flush();
    expect(errors).toHaveLength(1);
  });
});
