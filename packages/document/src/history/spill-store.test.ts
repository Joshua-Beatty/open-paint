/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import initWasm from "@openpaint/cpu";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeSpill, encodeSpill } from "./chunks";
import { MemorySpillStorage } from "./memory-spill-storage";
import { type SpillProcessor, type SpillStorage, SpillStore } from "./spill-store";

/** A processor whose encode waits for `encoded`, and whose decode is inline. */
function deferredProcessor(encoded: Promise<Uint8Array>): SpillProcessor {
  return {
    encode: () => encoded,
    decode: async (blob) => decodeSpill(blob),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeAll(async () => {
  const wasmPath = createRequire(import.meta.url).resolve("@openpaint/cpu/opaint_cpu_bg.wasm");
  await initWasm({ module_or_path: await readFile(wasmPath) });
});

/** Pseudo-random bytes, so the data does not compress and cache budgets bind. */
function pattern(length: number, seed: number): Uint8Array {
  let state = seed * 2654435761 + 1;
  return Uint8Array.from({ length }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state & 0xff;
  });
}

/** Storage that fails every write, to check that failures surface instead of being lost. */
class FailingStorage implements SpillStorage {
  async write(): Promise<void> {
    throw new Error("disk full");
  }
  async read(): Promise<Uint8Array> {
    throw new Error("unreadable");
  }
  async remove(): Promise<void> {}
}

describe("SpillStore (WEB-MEM-01, ARC-05-02)", () => {
  it("stores data write-once and reads back an equal copy", async () => {
    const storage = new MemorySpillStorage();
    const spill = new SpillStore({ storage, namespace: "t" });
    const data = pattern(200_000, 3);
    const handle = spill.put(data);
    expect(handle.rawBytes).toBe(200_000);

    const read = await spill.get(handle);
    expect(read).toEqual(data);
    read.fill(0);
    expect(await spill.get(handle)).toEqual(data);

    await spill.flush();
    expect(storage.size).toBe(1);
  });

  it("removes storage when a handle is released, after its pending write", async () => {
    const storage = new MemorySpillStorage();
    const spill = new SpillStore({ storage });
    const handle = spill.put(pattern(10, 1));
    spill.release(handle);
    expect(spill.liveCount).toBe(0);
    expect(spill.cachedBytes).toBe(0);
    await spill.flush();
    expect(storage.size).toBe(0);
    await expect(spill.get(handle)).rejects.toThrow("released");
  });

  it("evicts persisted entries to stay within the cache budget and reads them back from storage", async () => {
    const storage = new MemorySpillStorage();
    const spill = new SpillStore({ storage, cacheBytes: 2_000 });
    const handles = Array.from({ length: 10 }, (_, i) => spill.put(pattern(4_000, i)));
    await spill.flush();
    expect(spill.cachedBytes).toBeLessThanOrEqual(2_000);

    for (const [i, handle] of handles.entries()) {
      expect(await spill.get(handle)).toEqual(pattern(4_000, i));
    }
    expect(spill.cachedBytes).toBeLessThanOrEqual(2_000);
  });

  it("never evicts data that has not been written yet", async () => {
    const storage = new MemorySpillStorage();
    const spill = new SpillStore({ storage, cacheBytes: 0 });
    const handle = spill.put(pattern(5_000, 9));
    expect(await spill.get(handle)).toEqual(pattern(5_000, 9));
    await spill.flush();
    expect(spill.cachedBytes).toBe(0);
    expect(await spill.get(handle)).toEqual(pattern(5_000, 9));
  });

  it("can store uncompressed chunks", async () => {
    const storage = new MemorySpillStorage();
    const spill = new SpillStore({ storage, codec: "none" });
    const data = new Uint8Array(1_000);
    const handle = spill.put(data);
    await spill.flush();
    expect(spill.cachedBytes).toBeGreaterThan(data.length);
    expect(await spill.get(handle)).toEqual(data);
  });

  it("serves the data once its asynchronous encode finishes", async () => {
    const storage = new MemorySpillStorage();
    const encoding = deferred<Uint8Array>();
    const spill = new SpillStore({ storage, processor: deferredProcessor(encoding.promise) });
    const data = pattern(3_000, 4);
    const handle = spill.put(data);
    const read = spill.get(handle);
    expect(storage.size).toBe(0);

    const encoded = encodeSpill(data, "lz4");
    encoding.resolve(encoded);
    expect(await read).toEqual(data);
    await spill.flush();
    expect(storage.size).toBe(1);
    expect(spill.cachedBytes).toBe(encoded.length);
    expect(await spill.get(handle)).toEqual(data);
  });

  it("removes the storage of a handle released while its encode is pending", async () => {
    const storage = new MemorySpillStorage();
    const encoding = deferred<Uint8Array>();
    const spill = new SpillStore({ storage, processor: deferredProcessor(encoding.promise) });
    const handle = spill.put(pattern(500, 5));
    spill.release(handle);
    expect(spill.cachedBytes).toBe(0);
    encoding.resolve(encodeSpill(pattern(500, 5), "lz4"));
    await spill.flush();
    expect(storage.size).toBe(0);
    expect(spill.cachedBytes).toBe(0);
  });

  it("surfaces storage failures on flush", async () => {
    const spill = new SpillStore({ storage: new FailingStorage() });
    spill.put(pattern(100, 0));
    await expect(spill.flush()).rejects.toThrow("disk full");
    await expect(spill.flush()).resolves.toBeUndefined();
  });

  it("releases everything it holds when the store is released handle by handle", async () => {
    const storage = new MemorySpillStorage();
    const spill = new SpillStore({ storage });
    const handles = [spill.put(pattern(50, 1)), spill.put(pattern(50, 2))];
    for (const handle of handles) spill.release(handle);
    await spill.flush();
    expect(storage.size).toBe(0);
    expect(spill.liveCount).toBe(0);
  });

  it("keeps a pinned handle readable after its release, and frees it when the last pin ends", async () => {
    const storage = new MemorySpillStorage();
    const spill = new SpillStore({ storage });
    const handle = spill.put(pattern(1_000, 6));
    const other = spill.put(pattern(1_000, 7));
    const first = spill.pin([handle, other]);
    const second = spill.pin([handle]);
    spill.release(handle);
    spill.release(other);
    expect(await spill.get(handle)).toEqual(pattern(1_000, 6));
    first();
    first();
    await expect(spill.get(other)).rejects.toThrow("released");
    expect(await spill.get(handle)).toEqual(pattern(1_000, 6));
    second();
    await expect(spill.get(handle)).rejects.toThrow("released");
    await spill.flush();
    expect(storage.size).toBe(0);
    expect(spill.liveCount).toBe(0);
  });

  it("does not free a pinned handle that was never released", async () => {
    const spill = new SpillStore({ storage: new MemorySpillStorage() });
    const handle = spill.put(pattern(100, 8));
    spill.pin([handle])();
    expect(await spill.get(handle)).toEqual(pattern(100, 8));
    expect(spill.liveCount).toBe(1);
  });

  it("rejects a negative cache budget", () => {
    expect(() => new SpillStore({ storage: new MemorySpillStorage(), cacheBytes: -1 })).toThrow(
      RangeError,
    );
  });
});
