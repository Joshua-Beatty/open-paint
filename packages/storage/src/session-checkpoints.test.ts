import { afterEach, describe, expect, it, vi } from "vitest";
import {
  holdOwnerLock,
  liveSessionOwners,
  OpfsSessionStore,
  requestPersistentStorage,
  type SessionCheckpoint,
  sessionOwnerId,
} from "./session-checkpoints";

/** An in-memory OPFS tree with the handle members the session store uses. */
class FakeDirectory {
  readonly kind = "directory";
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

  async removeEntry(name: string, options: { recursive?: boolean } = {}): Promise<void> {
    if (this.#files.delete(name)) return;
    const directory = this.#directories.get(name);
    if (!directory || !options.recursive) throw new DOMException(name, "NotFoundError");
    this.#directories.delete(name);
  }

  async *entries(): AsyncGenerator<[string, FakeDirectory | FakeFileHandle]> {
    for (const [name, directory] of this.#directories) yield [name, directory];
    for (const name of this.#files.keys()) {
      yield [name, new FakeFileHandle(this.#files, name)];
    }
  }
}

class FakeFileHandle {
  readonly kind = "file";
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

function checkpoint(document: unknown, blobs: Record<string, number[]>): SessionCheckpoint {
  return {
    document,
    blobs: new Map(Object.entries(blobs).map(([name, bytes]) => [name, Uint8Array.from(bytes)])),
  };
}

function storeWithRoot(): { store: OpfsSessionStore; root: FakeDirectory } {
  const root = new FakeDirectory();
  const handle = root as unknown as FileSystemDirectoryHandle;
  return { store: new OpfsSessionStore(async () => handle), root };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpfsSessionStore (WEB-MEM-05)", () => {
  it("reads back what it wrote, with its blobs", async () => {
    const { store } = storeWithRoot();
    await store.write("owner", "doc", checkpoint({ name: "Sketch" }, { "layer-1": [1, 2, 3] }));
    const read = await store.read("owner", "doc");
    expect(read.document).toEqual({ name: "Sketch" });
    expect([...(read.blobs.get("layer-1") ?? [])]).toEqual([1, 2, 3]);
  });

  it("replaces a checkpoint and removes the blobs of the old one", async () => {
    const { store, root } = storeWithRoot();
    await store.write("owner", "doc", checkpoint({ v: 1 }, { "layer-1": [1], "history-0": [9] }));
    await store.write("owner", "doc", checkpoint({ v: 2 }, { "layer-1": [2] }));

    const read = await store.read("owner", "doc");
    expect(read.document).toEqual({ v: 2 });
    expect([...(read.blobs.get("layer-1") ?? [])]).toEqual([2]);
    expect(read.blobs.has("history-0")).toBe(false);

    const ownerDirectory = await root.getDirectoryHandle("owner");
    const docDirectory = await ownerDirectory.getDirectoryHandle("doc");
    const names: string[] = [];
    for await (const [name] of docDirectory.entries()) names.push(name);
    expect(names).toHaveLength(2);
  });

  it("keeps retained blobs without writing them again (L2)", async () => {
    const { store, root } = storeWithRoot();
    await store.write(
      "owner",
      "doc",
      checkpoint({ v: 1 }, { "layer-1-v5": [1], "history-3": [9] }),
    );
    const docDirectory = await (await root.getDirectoryHandle("owner")).getDirectoryHandle("doc");
    const kept = await docDirectory.getFileHandle("blob.history-3");
    const writable = vi.spyOn(kept.constructor.prototype, "createWritable");
    await store.write("owner", "doc", {
      ...checkpoint({ v: 2 }, { "layer-1-v8": [2] }),
      retained: ["history-3"],
    });
    // The new layer blob and the manifest; the retained history blob is not written.
    expect(writable).toHaveBeenCalledTimes(2);
    writable.mockRestore();

    const read = await store.read("owner", "doc");
    expect(read.document).toEqual({ v: 2 });
    expect([...(read.blobs.get("layer-1-v8") ?? [])]).toEqual([2]);
    expect([...(read.blobs.get("history-3") ?? [])]).toEqual([9]);
    expect(read.blobs.has("layer-1-v5")).toBe(false);
    const names: string[] = [];
    for await (const [name] of docDirectory.entries()) names.push(name);
    expect(names.sort()).toEqual(["blob.history-3", "blob.layer-1-v8", "manifest.json"]);
  });

  it("reads a checkpoint whose blobs carry a generation prefix", async () => {
    const { store, root } = storeWithRoot();
    const docDirectory = await (
      await root.getDirectoryHandle("owner", { create: true })
    ).getDirectoryHandle("doc", { create: true });
    const put = async (name: string, data: Uint8Array) => {
      const writable = await (
        await docDirectory.getFileHandle(name, { create: true })
      ).createWritable();
      await writable.write(data);
      await writable.close();
    };
    await put("g1.layer-1", Uint8Array.from([7]));
    await put(
      "manifest.json",
      new TextEncoder().encode(
        JSON.stringify({ generation: "g1", blobs: ["layer-1"], document: {} }),
      ),
    );
    expect([...((await store.read("owner", "doc")).blobs.get("layer-1") ?? [])]).toEqual([7]);
  });

  it("lists every stored checkpoint by owner and key", async () => {
    const { store } = storeWithRoot();
    await store.write("a", "one", checkpoint({}, {}));
    await store.write("a", "two", checkpoint({}, {}));
    await store.write("b", "three", checkpoint({}, {}));
    const listed = await store.list();
    expect(listed).toHaveLength(3);
    expect(listed).toEqual(expect.arrayContaining([{ owner: "b", key: "three" }]));
  });

  it("removes one checkpoint and ignores one that is already gone", async () => {
    const { store } = storeWithRoot();
    await store.write("owner", "doc", checkpoint({}, {}));
    await store.remove("owner", "doc");
    await expect(store.read("owner", "doc")).rejects.toThrow();
    await expect(store.remove("owner", "doc")).resolves.toBeUndefined();
    await expect(store.remove("missing", "doc")).resolves.toBeUndefined();
  });

  it("rejects a damaged manifest so the caller can skip it", async () => {
    const { store, root } = storeWithRoot();
    await store.write("owner", "doc", checkpoint({}, {}));
    const docDirectory = await (await root.getDirectoryHandle("owner")).getDirectoryHandle("doc");
    const manifest = await docDirectory.getFileHandle("manifest.json");
    const writable = await manifest.createWritable();
    await writable.write(new TextEncoder().encode("{}"));
    await writable.close();
    await expect(store.read("owner", "doc")).rejects.toThrow("damaged");
  });

  it("refuses ids that could escape the folder", async () => {
    const { store } = storeWithRoot();
    await expect(store.write("../x", "doc", checkpoint({}, {}))).rejects.toThrow(RangeError);
  });
});

describe("session owner and liveness (SET-LIFE-02)", () => {
  it("keeps one owner id for the tab", () => {
    const first = sessionOwnerId();
    expect(sessionOwnerId()).toBe(first);
    expect(first).toMatch(/^[a-z0-9]+$/);
  });

  it("reports the owners whose lock is held", async () => {
    const requested: string[] = [];
    vi.stubGlobal("navigator", {
      locks: {
        request: async (name: string) => {
          requested.push(name);
        },
        query: async () => ({
          held: [{ name: "openpaint-session-owner:alive" }, { name: "other" }],
        }),
      },
    });
    holdOwnerLock("mine");
    expect(requested).toEqual(["openpaint-session-owner:mine"]);
    expect([...((await liveSessionOwners()) as ReadonlySet<string>)]).toEqual(["alive"]);
  });

  it("treats every owner as live without the Web Locks API", async () => {
    vi.stubGlobal("navigator", {});
    expect(await liveSessionOwners()).toBe("all");
  });

  it("reports the persistence grant, and false when the request fails", async () => {
    vi.stubGlobal("navigator", { storage: { persist: async () => true } });
    expect(await requestPersistentStorage()).toBe(true);
    vi.stubGlobal("navigator", {
      storage: {
        persist: async () => {
          throw new Error("denied");
        },
      },
    });
    expect(await requestPersistentStorage()).toBe(false);
  });
});
