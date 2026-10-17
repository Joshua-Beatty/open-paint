import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  ERROR_LOG_CAPACITY,
  ErrorLog,
  type ErrorLogBackend,
  type ErrorLogEntry,
  IndexedDbErrorLogBackend,
  MemoryErrorLogBackend,
} from "./error-log";

function entryText(index: number): { time: string; title: string; text: string } {
  return {
    time: `2026-10-13T00:00:${String(index).padStart(2, "0")}.000Z`,
    title: `Error ${index}`,
    text: `Body ${index}`,
  };
}

/** A backend whose writes fail, to test the in-memory fallback. */
class FailingBackend implements ErrorLogBackend {
  async readAll(): Promise<readonly ErrorLogEntry[]> {
    throw new Error("read failed");
  }

  async replaceAll(): Promise<void> {
    throw new Error("write failed");
  }
}

describe("ErrorLog (SET-ERR-01)", () => {
  it("keeps the newest entry with the 19 most recent older ones", () => {
    const log = new ErrorLog(new MemoryErrorLogBackend());
    for (let index = 1; index <= 25; index += 1) log.record(entryText(index));

    expect(log.entries).toHaveLength(ERROR_LOG_CAPACITY);
    expect(ERROR_LOG_CAPACITY).toBe(20);
    expect(log.entries[0]?.title).toBe("Error 25");
    expect(log.entries.at(-1)?.title).toBe("Error 6");
  });

  it("lists entries newest first with increasing ids", () => {
    const log = new ErrorLog(new MemoryErrorLogBackend());
    log.record(entryText(1));
    log.record(entryText(2));

    expect(log.entries.map((entry) => entry.id)).toEqual([2, 1]);
    expect(log.entries[0]?.text).toBe("Body 2");
  });

  it("changes the entries array on every change, so a React snapshot sees it", () => {
    const log = new ErrorLog(new MemoryErrorLogBackend());
    const before = log.entries;
    log.record(entryText(1));

    expect(log.entries).not.toBe(before);
    expect(before).toHaveLength(0);
  });

  it("notifies subscribers and stops after unsubscribe", () => {
    const log = new ErrorLog(new MemoryErrorLogBackend());
    let calls = 0;
    const stop = log.subscribe(() => {
      calls += 1;
    });
    log.record(entryText(1));
    stop();
    log.record(entryText(2));

    expect(calls).toBe(1);
  });

  it("clears every entry", async () => {
    const backend = new MemoryErrorLogBackend();
    const log = new ErrorLog(backend);
    log.record(entryText(1));
    log.record(entryText(2));
    log.clear();
    await log.settled();

    expect(log.entries).toEqual([]);
    expect(await backend.readAll()).toEqual([]);
  });

  it("writes the retained list to the backend", async () => {
    const backend = new MemoryErrorLogBackend();
    const log = new ErrorLog(backend);
    for (let index = 1; index <= 22; index += 1) log.record(entryText(index));
    await log.settled();

    const stored = await backend.readAll();
    expect(stored).toHaveLength(ERROR_LOG_CAPACITY);
    expect(stored[0]?.title).toBe("Error 22");
  });

  it("reopens with the stored entries and continues the ids", async () => {
    const backend = new MemoryErrorLogBackend();
    const first = new ErrorLog(backend);
    first.record(entryText(1));
    first.record(entryText(2));
    await first.settled();

    const reopened = await ErrorLog.open(backend);
    const next = reopened.record(entryText(3));

    expect(next.id).toBe(3);
    expect(reopened.entries.map((entry) => entry.title)).toEqual(["Error 3", "Error 2", "Error 1"]);
  });

  it("keeps entries in memory when the write fails", async () => {
    const log = new ErrorLog(new FailingBackend());
    log.record(entryText(1));
    await log.settled();

    expect(log.persisted).toBe(false);
    expect(log.entries).toHaveLength(1);
  });

  it("starts empty and unpersisted when the stored entries cannot be read", async () => {
    const log = await ErrorLog.open(new FailingBackend());

    expect(log.persisted).toBe(false);
    expect(log.entries).toEqual([]);
    log.record(entryText(1));
    expect(log.entries).toHaveLength(1);
  });

  it("marks the log persisted again after a later write succeeds", async () => {
    let fail = true;
    const memory = new MemoryErrorLogBackend();
    const backend: ErrorLogBackend = {
      readAll: () => memory.readAll(),
      replaceAll: async (entries) => {
        if (fail) throw new Error("quota");
        await memory.replaceAll(entries);
      },
    };
    const log = new ErrorLog(backend);
    log.record(entryText(1));
    await log.settled();
    expect(log.persisted).toBe(false);

    fail = false;
    log.record(entryText(2));
    await log.settled();
    expect(log.persisted).toBe(true);
  });
});

describe("IndexedDbErrorLogBackend", () => {
  it("keeps the entries across a reopen", async () => {
    const name = `diagnostics-${crypto.randomUUID()}`;
    const log = new ErrorLog(new IndexedDbErrorLogBackend(name));
    log.record(entryText(1));
    log.record(entryText(2));
    await log.settled();

    const reopened = await ErrorLog.open(new IndexedDbErrorLogBackend(name));

    expect(reopened.entries.map((entry) => entry.title)).toEqual(["Error 2", "Error 1"]);
    expect(reopened.persisted).toBe(true);
  });
});
