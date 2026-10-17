import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  IndexedDbRecentFilesBackend,
  MemoryRecentFilesBackend,
  RECENT_FILES_CAPACITY,
  RecentFiles,
  type RecentFilesBackend,
} from "./recent-files";

class FailingBackend implements RecentFilesBackend {
  async readAll(): Promise<never> {
    throw new Error("read failed");
  }

  async replaceAll(): Promise<void> {
    throw new Error("write failed");
  }
}

describe("RecentFiles (FMT-OPEN-06)", () => {
  it("keeps ten entries, newest first", () => {
    const recent = new RecentFiles(new MemoryRecentFilesBackend());
    for (let index = 1; index <= 12; index += 1) recent.add({ name: `file-${index}.png` });

    expect(RECENT_FILES_CAPACITY).toBe(10);
    expect(recent.entries).toHaveLength(10);
    expect(recent.entries[0]?.name).toBe("file-12.png");
    expect(recent.entries.at(-1)?.name).toBe("file-3.png");
  });

  it("moves a file with the same name to the front instead of listing it twice", () => {
    const recent = new RecentFiles(new MemoryRecentFilesBackend());
    recent.add({ name: "a.png" });
    recent.add({ name: "b.png" });
    const moved = recent.add({ name: "a.png", thumbnail: "data:image/png;base64,AAAA" });

    expect(recent.entries.map((entry) => entry.name)).toEqual(["a.png", "b.png"]);
    expect(recent.entries[0]?.id).toBe(moved.id);
    expect(recent.entries[0]?.thumbnail).toBe("data:image/png;base64,AAAA");
  });

  it("removes one entry and clears the list", () => {
    const recent = new RecentFiles(new MemoryRecentFilesBackend());
    const first = recent.add({ name: "a.png" });
    recent.add({ name: "b.png" });

    recent.remove(first.id);
    expect(recent.entries.map((entry) => entry.name)).toEqual(["b.png"]);
    expect(recent.get(first.id)).toBeUndefined();

    recent.clear();
    expect(recent.entries).toEqual([]);
  });

  it("notifies subscribers and gives a new array on every change", () => {
    const recent = new RecentFiles(new MemoryRecentFilesBackend());
    let calls = 0;
    const stop = recent.subscribe(() => {
      calls += 1;
    });
    const before = recent.entries;
    recent.add({ name: "a.png" });
    expect(calls).toBe(1);
    expect(recent.entries).not.toBe(before);
    stop();
    recent.add({ name: "b.png" });
    expect(calls).toBe(1);
  });

  it("keeps the entries in memory when the store cannot be written", async () => {
    const recent = await RecentFiles.open(new FailingBackend());
    expect(recent.persisted).toBe(false);
    recent.add({ name: "a.png" });
    await recent.settled();
    expect(recent.entries).toHaveLength(1);
    expect(recent.persisted).toBe(false);
  });

  it("stores entries in IndexedDB with their handles and reloads them newest first", async () => {
    const databaseName = "openpaint-recent-test";
    const writer = new RecentFiles(new IndexedDbRecentFilesBackend(databaseName));
    writer.add({ name: "a.png", thumbnail: "data:image/png;base64,AAAA", thumbnailScale: 2 });
    writer.add({ name: "b.png" });
    await writer.settled();
    expect(writer.persisted).toBe(true);

    const reader = await RecentFiles.open(new IndexedDbRecentFilesBackend(databaseName));
    expect(reader.entries.map((entry) => entry.name)).toEqual(["b.png", "a.png"]);
    expect(reader.entries[1]?.thumbnailScale).toBe(2);
  });
});
