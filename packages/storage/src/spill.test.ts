import { MemorySpillStorage, type SpillStorage } from "@openpaint/document";
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpillStorage } from "./spill";
import { IndexedDbSpillStorage } from "./spill-indexeddb";
import { OpfsSpillStorage } from "./spill-opfs";

/** An in-memory OPFS tree with the handle methods the adapter uses. */
class FakeDirectory {
  readonly #directories = new Map<string, FakeDirectory>();
  readonly #files = new Map<string, Uint8Array>();

  async getDirectoryHandle(
    name: string,
    options: { create?: boolean } = {},
  ): Promise<FakeDirectory> {
    let directory = this.#directories.get(name);
    if (!directory) {
      if (!options.create) throw new DOMException(name, "NotFoundError");
      directory = new FakeDirectory();
      this.#directories.set(name, directory);
    }
    return directory;
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<FakeFileHandle> {
    if (!this.#files.has(name)) {
      if (!options.create) throw new DOMException(name, "NotFoundError");
      this.#files.set(name, new Uint8Array(0));
    }
    return new FakeFileHandle(this.#files, name);
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.#files.delete(name)) throw new DOMException(name, "NotFoundError");
  }
}

class FakeFileHandle {
  readonly #files: Map<string, Uint8Array>;
  readonly #name: string;

  constructor(files: Map<string, Uint8Array>, name: string) {
    this.#files = files;
    this.#name = name;
  }

  async createWritable(): Promise<{
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }> {
    let staged = new Uint8Array(0);
    return {
      write: async (data) => {
        staged = data.slice();
      },
      close: async () => {
        this.#files.set(this.#name, staged);
      },
      abort: async () => {},
    };
  }

  async getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }> {
    const data = this.#files.get(this.#name) ?? new Uint8Array(0);
    return { arrayBuffer: async () => data.slice().buffer };
  }
}

function blob(length: number, seed: number): Uint8Array {
  let state = seed * 2654435761 + 7;
  return Uint8Array.from({ length }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state & 0xff;
  });
}

let uniqueName = 0;

const adapters: [string, () => SpillStorage][] = [
  ["memory", () => new MemorySpillStorage()],
  [
    "OPFS",
    () => {
      vi.stubGlobal("navigator", { storage: { getDirectory: async () => new FakeDirectory() } });
      return new OpfsSpillStorage(`test-${uniqueName++}`);
    },
  ],
  ["IndexedDB", () => new IndexedDbSpillStorage(`test-${uniqueName++}`)],
];

describe.each(adapters)("undo data storage: %s (WEB-MEM-01)", (_, create) => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes a blob and reads back the same bytes", async () => {
    const storage = create();
    const data = blob(300_000, 1);
    await storage.write("spill-1", data);
    expect(await storage.read("spill-1")).toEqual(data);
  });

  it("replaces a blob written under the same key", async () => {
    const storage = create();
    await storage.write("k", blob(10, 1));
    await storage.write("k", blob(20, 2));
    expect(await storage.read("k")).toEqual(blob(20, 2));
  });

  it("rejects reads of a missing key", async () => {
    const storage = create();
    await expect(storage.read("missing")).rejects.toThrow();
  });

  it("removes a key, and removing a missing key does nothing", async () => {
    const storage = create();
    await storage.write("k", blob(5, 3));
    await storage.remove("k");
    await expect(storage.read("k")).rejects.toThrow();
    await expect(storage.remove("k")).resolves.toBeUndefined();
  });
});

describe("createSpillStorage (WEB-MEM-01)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("chooses OPFS when the browser has it", async () => {
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => new FakeDirectory() } });
    const storage = createSpillStorage();
    expect(storage).toBeInstanceOf(OpfsSpillStorage);
    await storage.write("probe", blob(4, 0));
    expect(await storage.read("probe")).toEqual(blob(4, 0));
  });

  it("falls back to IndexedDB when OPFS is missing", () => {
    vi.stubGlobal("navigator", {});
    expect(createSpillStorage()).toBeInstanceOf(IndexedDbSpillStorage);
  });

  it("throws when neither store exists", () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("indexedDB", undefined);
    expect(() => createSpillStorage()).toThrow("Neither OPFS nor IndexedDB");
  });
});
