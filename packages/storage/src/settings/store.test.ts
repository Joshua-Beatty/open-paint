import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { IndexedDbSettingsBackend, MemorySettingsBackend, type SettingsBackend } from "./backend";
import type { SettingsChangeMessage, SettingsChannel } from "./channel";
import { SETTINGS_SCHEMA_VERSION, type SettingsMigration } from "./migrations";
import { type MirrorStorage, readEarlySetting } from "./mirror";
import {
  SCHEMA_VERSION_KEY,
  SettingsError,
  SettingsStore,
  type SettingsStoreOptions,
} from "./store";

/** A backend that counts commits and can be told to fail them. */
class CountingBackend extends MemorySettingsBackend {
  commits = 0;
  failNext = false;

  override async commit(
    writes: ReadonlyMap<string, unknown>,
    deletes: ReadonlySet<string>,
  ): Promise<void> {
    this.commits += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new Error("disk full");
    }
    await super.commit(writes, deletes);
  }
}

class MapMirror implements MirrorStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

/** Two or more channels on one bus. A message reaches every other channel asynchronously. */
class ChannelBus {
  readonly #peers = new Set<{ listeners: Set<(message: unknown) => void> }>();

  connect(): SettingsChannel {
    const peer = { listeners: new Set<(message: unknown) => void>() };
    this.#peers.add(peer);
    return {
      post: (message: SettingsChangeMessage) => {
        for (const other of this.#peers) {
          if (other === peer) continue;
          setTimeout(() => {
            const copy = structuredClone(message);
            for (const listener of other.listeners) listener(copy);
          }, 0);
        }
      },
      listen: (listener) => {
        peer.listeners.add(listener);
        return () => peer.listeners.delete(listener);
      },
      close: () => {
        this.#peers.delete(peer);
      },
    };
  }

  /** Delivers a raw message to every channel on the bus, as another tab could send it. */
  inject(message: unknown): void {
    for (const peer of this.#peers) {
      setTimeout(() => {
        for (const listener of peer.listeners) listener(message);
      }, 0);
    }
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const opened: SettingsStore[] = [];

async function open(options: SettingsStoreOptions = {}): Promise<SettingsStore> {
  const store = await SettingsStore.open({
    backend: new MemorySettingsBackend(),
    channel: null,
    mirror: null,
    lifecycle: null,
    flushDelayMs: 60_000,
    ...options,
  });
  opened.push(store);
  return store;
}

afterEach(async () => {
  for (const store of opened.splice(0)) await store.dispose();
});

describe("SettingsStore reads and writes (SET-STO-02)", () => {
  it("returns the defaults before anything is stored", async () => {
    const store = await open();
    expect(store.persistent).toBe(true);
    expect(store.get("canvas.dropShadow")).toBe(true);
    expect(store.get("tools.brush.size")).toBe(2);
    expect(store.get("toolDefaults.activeTool")).toBe("paintbrush");
    expect(store.get("effects.defaultQualityGpu")).toBe(1);
    expect(store.get("effects.lastValues.gaussian-blur")).toBeUndefined();
  });

  it("stores a value and returns it", async () => {
    const store = await open();
    store.set("ui.theme", "Dark");
    store.set("tools.brush.size", 12);
    expect(store.get("ui.theme")).toBe("Dark");
    expect(store.get("tools.brush.size")).toBe(12);
  });

  it("clamps numbers on write", async () => {
    const store = await open();
    store.set("tools.brush.size", 5000);
    store.set("canvas.checkerboardBrightness", 0);
    store.set("effects.defaultQualityCpu", 2.6);
    expect(store.get("tools.brush.size")).toBe(2000);
    expect(store.get("canvas.checkerboardBrightness")).toBe(0.25);
    expect(store.get("effects.defaultQualityCpu")).toBe(3);
  });

  it("rejects an invalid value and an unknown path", async () => {
    const store = await open();
    expect(() => store.set("ui.theme", "Blue")).toThrow(SettingsError);
    expect(() => store.set("tools.brush.size", Number.NaN)).toThrow(SettingsError);
    expect(() => store.set("unknown.setting", true)).toThrow(SettingsError);
    expect(() => store.get("unknown.setting")).toThrow(SettingsError);
    expect(store.get("ui.theme")).toBe("Automatic");
  });

  it("returns copies of structured values, so callers cannot change the store", async () => {
    const store = await open();
    store.set("effects.lastValues.gaussian-blur", { radius: 4 });
    const read = store.get("effects.lastValues.gaussian-blur") as { radius: number };
    read.radius = 99;
    expect(store.get("effects.lastValues.gaussian-blur")).toEqual({ radius: 4 });
  });

  it("remembers effect values per effect (SET-STO-06)", async () => {
    const store = await open();
    store.set("effects.lastValues.gaussian-blur", { radius: 4 });
    store.set("adjustments.lastValues.levels", { gamma: 1.2 });
    expect(store.get("effects.lastValues.gaussian-blur")).toEqual({ radius: 4 });
    expect(store.get("adjustments.lastValues.levels")).toEqual({ gamma: 1.2 });
    store.reset("effects.lastValues.gaussian-blur");
    expect(store.get("effects.lastValues.gaussian-blur")).toBeUndefined();
  });

  it("stores the window dialog bounds as rectangles", async () => {
    const store = await open();
    store.set("window.dialogs.save.bounds", { x: 10, y: 20, width: 400, height: 300 });
    expect(store.get("window.dialogs.save.bounds")).toEqual({
      x: 10,
      y: 20,
      width: 400,
      height: 300,
    });
  });

  it("sets the GPU quality default by performance class (SET-DLG-07)", async () => {
    const store = await open();
    store.setGpuPerformanceClass("Good");
    expect(store.get("effects.defaultQualityGpu")).toBe(2);
    store.set("effects.defaultQualityGpu", 6);
    store.reset("effects.defaultQualityGpu");
    expect(store.get("effects.defaultQualityGpu")).toBe(2);
  });

  it("defaults Animations off while reduced motion is requested (WEB-UI-04)", async () => {
    const store = await open();
    expect(store.get("ui.animations")).toBe(true);
    store.setReducedMotion(true);
    expect(store.get("ui.animations")).toBe(false);
    store.setGpuPerformanceClass("Good");
    expect(store.get("ui.animations")).toBe(false);
    store.setReducedMotion(false);
    expect(store.get("ui.animations")).toBe(true);
  });

  it("keeps a stored Animations choice when reduced motion changes", async () => {
    const store = await open();
    store.set("ui.animations", true);
    store.setReducedMotion(true);
    expect(store.get("ui.animations")).toBe(true);
    store.reset("ui.animations");
    expect(store.get("ui.animations")).toBe(false);
  });

  it("resets the GPU quality when the backend changes (SET-DLG-07a)", async () => {
    const store = await open();
    store.set("graphics.backend", "Cpu");
    store.set("effects.defaultQualityGpu", 7);
    store.changeBackend("WebGPU", "Good");
    expect(store.get("graphics.backend")).toBe("WebGPU");
    expect(store.get("effects.defaultQualityGpu")).toBe(2);
    store.changeBackend("Cpu", "VeryLow");
    expect(store.get("effects.defaultQualityGpu")).toBe(1);
  });

  it("rejects an unknown backend choice", async () => {
    const store = await open();
    expect(() => store.changeBackend("Vulkan", "Good")).toThrow(SettingsError);
    expect(store.get("graphics.backend")).toBe("Automatic");
  });
});

describe("SettingsStore storage (SET-STO-01)", () => {
  it("batches writes and flushes them once", async () => {
    const backend = new CountingBackend();
    const store = await open({ backend, flushDelayMs: 5 });
    store.set("tools.brush.size", 4);
    store.set("tools.brush.size", 5);
    store.set("ui.animations", false);
    await wait(40);
    expect(backend.commits).toBe(1);
    const records = await backend.readAll();
    expect(records.get("tools.brush.size")).toBe(5);
    expect(records.get("ui.animations")).toBe(false);
  });

  it("does not write until the delay has passed or a flush is requested", async () => {
    const backend = new CountingBackend();
    const store = await open({ backend });
    store.set("ui.overscroll", false);
    await tick();
    expect(backend.commits).toBe(0);
    await store.flush();
    expect(backend.commits).toBe(1);
    expect((await backend.readAll()).get("ui.overscroll")).toBe(false);
  });

  it("flushes when the page is hidden or closed", async () => {
    const backend = new CountingBackend();
    const page = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const store = await open({ backend, lifecycle: { page, document: doc } });

    store.set("ui.overscroll", false);
    doc.dispatchEvent(new Event("visibilitychange"));
    await tick();
    expect(backend.commits).toBe(0);

    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    await tick();
    expect(backend.commits).toBe(1);

    store.set("ui.animations", false);
    page.dispatchEvent(new Event("pagehide"));
    await tick();
    expect(backend.commits).toBe(2);
  });

  it("keeps the settings after a reload", async () => {
    const backend = new MemorySettingsBackend();
    const first = await open({ backend });
    first.set("canvas.customBorderColor", { r: 1, g: 2, b: 3, a: 255 });
    first.set("layout.rightSidebar.width", 350);
    first.set("window.dialogs.save.bounds", { x: 1, y: 2, width: 3, height: 4 });
    await first.flush();

    const second = await open({ backend });
    expect(second.get("canvas.customBorderColor")).toEqual({ r: 1, g: 2, b: 3, a: 255 });
    expect(second.get("layout.rightSidebar.width")).toBe(350);
    expect(second.get("window.dialogs.save.bounds")).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it("stores settings in IndexedDB and keeps them after reopening", async () => {
    const name = `settings-test-${Math.random().toString(36).slice(2)}`;
    const first = await open({ backend: new IndexedDbSettingsBackend(name) });
    first.set("ui.theme", "Light");
    first.set("workspace.lastCanvasSizeAnchor", "Bottom");
    await first.flush();

    const second = await open({ backend: new IndexedDbSettingsBackend(name) });
    expect(second.get("ui.theme")).toBe("Light");
    expect(second.get("workspace.lastCanvasSizeAnchor")).toBe("Bottom");
    expect((await new IndexedDbSettingsBackend(name).readAll()).get(SCHEMA_VERSION_KEY)).toBe(
      SETTINGS_SCHEMA_VERSION,
    );
  });

  it("works in memory when storage cannot be opened", async () => {
    const broken: SettingsBackend = {
      readAll: async () => {
        throw new Error("blocked");
      },
      commit: async () => {
        throw new Error("never called");
      },
    };
    const store = await open({ backend: broken });
    expect(store.persistent).toBe(false);
    store.set("ui.theme", "Dark");
    expect(store.get("ui.theme")).toBe("Dark");
    await store.flush();
  });

  it("keeps pending writes when a flush fails, and writes them on the next flush", async () => {
    const backend = new CountingBackend();
    const store = await open({ backend });
    store.set("ui.overscroll", false);
    backend.failNext = true;
    await expect(store.flush()).rejects.toThrow("disk full");
    await store.flush();
    expect((await backend.readAll()).get("ui.overscroll")).toBe(false);
  });

  it("reads stored values through validation and falls back to defaults", async () => {
    const backend = new MemorySettingsBackend();
    await backend.commit(
      new Map<string, unknown>([
        [SCHEMA_VERSION_KEY, SETTINGS_SCHEMA_VERSION],
        ["canvas.dropShadow", "yes"],
        ["canvas.checkerboardBrightness", 9],
        ["effects.defaultQualityCpu", 2.6],
        ["layout.rightSidebar.splitRatios", [0.2, 0.3]],
        ["file.recent", Array.from({ length: 12 }, (_, index) => index)],
        ["legacy.thing", { keep: true }],
      ]),
      new Set(),
    );
    const store = await open({ backend });
    expect(store.get("canvas.dropShadow")).toBe(true);
    expect(store.get("canvas.checkerboardBrightness")).toBe(1);
    expect(store.get("effects.defaultQualityCpu")).toBe(3);
    expect(store.get("layout.rightSidebar.splitRatios")).toEqual([]);
    expect(store.get("file.recent")).toHaveLength(10);

    await store.dispose();
    expect((await backend.readAll()).get("legacy.thing")).toEqual({ keep: true });
  });

  it("writes the schema version on a new store", async () => {
    const backend = new MemorySettingsBackend();
    await open({ backend }).then((store) => store.flush());
    expect((await backend.readAll()).get(SCHEMA_VERSION_KEY)).toBe(SETTINGS_SCHEMA_VERSION);
  });
});

describe("SettingsStore migrations (SET-STO-01)", () => {
  it("runs ordered migrations before any setting is read, and keeps unknown keys", async () => {
    const backend = new MemorySettingsBackend();
    await backend.commit(
      new Map<string, unknown>([
        [SCHEMA_VERSION_KEY, 1],
        ["ui.scrollPastEdge", false],
        ["legacy.thing", "kept"],
      ]),
      new Set(),
    );
    const migrations: SettingsMigration[] = [
      {
        from: 1,
        migrate: (records) => {
          records.set("ui.overscroll", records.get("ui.scrollPastEdge"));
          records.delete("ui.scrollPastEdge");
        },
      },
    ];
    const store = await open({ backend, migrations, schemaVersion: 2 });
    expect(store.get("ui.overscroll")).toBe(false);

    await store.flush();
    const records = await backend.readAll();
    expect(records.has("ui.scrollPastEdge")).toBe(false);
    expect(records.get("ui.overscroll")).toBe(false);
    expect(records.get("legacy.thing")).toBe("kept");
    expect(records.get(SCHEMA_VERSION_KEY)).toBe(2);
  });

  it("does not touch a store written by a newer version", async () => {
    const backend = new MemorySettingsBackend();
    await backend.commit(new Map<string, unknown>([[SCHEMA_VERSION_KEY, 5]]), new Set());
    let ran = false;
    const migrations: SettingsMigration[] = [
      {
        from: 1,
        migrate: () => {
          ran = true;
        },
      },
    ];
    const store = await open({ backend, migrations, schemaVersion: 2 });
    await store.flush();
    expect(ran).toBe(false);
    expect((await backend.readAll()).get(SCHEMA_VERSION_KEY)).toBe(5);
  });
});

describe("SettingsStore resets (SET-STO-05, SET-STO-06)", () => {
  it("resetAll restores every setting and forgets remembered values, keeping unknown keys", async () => {
    const backend = new MemorySettingsBackend();
    await backend.commit(new Map<string, unknown>([["legacy.thing", 1]]), new Set());
    const store = await open({ backend });
    store.set("ui.theme", "Dark");
    store.set("tools.brush.size", 40);
    store.set("effects.lastValues.gaussian-blur", { radius: 9 });
    store.set("window.dialogs.save.bounds", { x: 1, y: 2, width: 3, height: 4 });
    await store.flush();

    store.resetAll();
    expect(store.get("ui.theme")).toBe("Automatic");
    expect(store.get("tools.brush.size")).toBe(2);
    expect(store.get("effects.lastValues.gaussian-blur")).toBeUndefined();
    expect(store.get("window.dialogs.save.bounds")).toBeUndefined();

    await store.flush();
    const records = await backend.readAll();
    expect(records.has("ui.theme")).toBe(false);
    expect(records.has("effects.lastValues.gaussian-blur")).toBe(false);
    expect(records.get("legacy.thing")).toBe(1);
    expect(records.get(SCHEMA_VERSION_KEY)).toBe(SETTINGS_SCHEMA_VERSION);
  });

  it("resetPanelLayout restores only the layout settings", async () => {
    const store = await open();
    store.set("layout.panels.tools.visible", false);
    store.set("layout.panels.history.collapsed", true);
    store.set("layout.rightSidebar.width", 400);
    store.set("layout.rightSidebar.splitRatios", [0.5, 0.25, 0.25]);
    store.set("window.dialogs.save.bounds", { x: 5, y: 6, width: 7, height: 8 });
    store.set("ui.theme", "Dark");

    store.resetPanelLayout();
    expect(store.get("layout.panels.tools.visible")).toBe(true);
    expect(store.get("layout.panels.history.collapsed")).toBe(false);
    expect(store.get("layout.rightSidebar.width")).toBe(280);
    expect(store.get("layout.rightSidebar.splitRatios")).toEqual([]);
    expect(store.get("window.dialogs.save.bounds")).toEqual({ x: 5, y: 6, width: 7, height: 8 });
    expect(store.get("ui.theme")).toBe("Dark");
  });

  it("reset restores one setting to its default", async () => {
    const store = await open();
    store.set("tools.brush.hardness", 0.1);
    store.reset("tools.brush.hardness");
    expect(store.get("tools.brush.hardness")).toBe(0.75);
    expect(() => store.reset("nothing.here")).toThrow(SettingsError);
  });
});

describe("SettingsStore change events", () => {
  it("reports local changes with their effective value", async () => {
    const store = await open();
    const seen: unknown[] = [];
    const stop = store.onChange((change) => seen.push(change));
    store.set("ui.animations", false);
    store.reset("ui.animations");
    stop();
    store.set("ui.animations", false);
    expect(seen).toEqual([
      { path: "ui.animations", value: false, source: "local" },
      { path: "ui.animations", value: true, source: "local" },
    ]);
  });
});

describe("SettingsStore theme mirror (SET-STO-01)", () => {
  it("mirrors the theme so it can be read before IndexedDB opens", async () => {
    const mirror = new MapMirror();
    const store = await open({ mirror });
    store.set("ui.theme", "Dark");
    expect(mirror.items.get("openpaint.setting.ui.theme")).toBe("Dark");
    expect(readEarlySetting("ui.theme", mirror)).toBe("Dark");

    store.reset("ui.theme");
    expect(readEarlySetting("ui.theme", mirror)).toBeUndefined();
  });

  it("makes the mirror match IndexedDB when the store opens", async () => {
    const mirror = new MapMirror();
    mirror.items.set("openpaint.setting.ui.theme", "Light");
    await open({ mirror });
    expect(mirror.items.get("openpaint.setting.ui.theme")).toBe("Automatic");
  });

  it("ignores mirrored values for settings that are not mirrored", () => {
    expect(readEarlySetting("ui.animations", new MapMirror())).toBeUndefined();
  });
});

describe("SettingsStore live sync (WEB-UI-07)", () => {
  it("applies another tab's changes without writing them again", async () => {
    const bus = new ChannelBus();
    const backendA = new CountingBackend();
    const backendB = new CountingBackend();
    const a = await open({ backend: backendA, channel: bus.connect() });
    const b = await open({ backend: backendB, channel: bus.connect() });
    await b.flush();
    const seen: unknown[] = [];
    b.onChange((change) => seen.push(change));
    const commitsBefore = backendB.commits;

    a.set("canvas.dropShadow", false);
    a.set("effects.lastValues.gaussian-blur", { radius: 2 });
    await wait(5);

    expect(b.get("canvas.dropShadow")).toBe(false);
    expect(b.get("effects.lastValues.gaussian-blur")).toEqual({ radius: 2 });
    expect(seen).toContainEqual({ path: "canvas.dropShadow", value: false, source: "remote" });

    await b.flush();
    expect(backendB.commits).toBe(commitsBefore);
    await a.flush();
    expect((await backendA.readAll()).get("canvas.dropShadow")).toBe(false);
  });

  it("propagates resets to other tabs", async () => {
    const bus = new ChannelBus();
    const a = await open({ channel: bus.connect() });
    const b = await open({ channel: bus.connect() });
    a.set("ui.theme", "Dark");
    a.set("layout.rightSidebar.width", 300);
    await wait(5);
    expect(b.get("ui.theme")).toBe("Dark");

    a.resetAll();
    await wait(5);
    expect(b.get("ui.theme")).toBe("Automatic");
    expect(b.get("layout.rightSidebar.width")).toBe(280);
  });

  it("ignores messages that do not describe a valid change", async () => {
    const bus = new ChannelBus();
    const store = await open({ channel: bus.connect() });
    bus.inject({ type: "other" });
    bus.inject({ type: "settings-changed", changes: "nope" });
    bus.inject({
      type: "settings-changed",
      changes: [
        { path: "brush.size.unknown", value: 1 },
        { path: "tools.brush.size", value: "wide" },
        { path: "ui.theme", value: "Dark" },
      ],
    });
    await wait(5);
    expect(store.get("tools.brush.size")).toBe(2);
    expect(store.get("ui.theme")).toBe("Dark");
  });
});
