import { MemorySettingsBackend, SettingsStore } from "@openpaint/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadToolbarIntoDefaults, resetToolDefaults } from "./tool-defaults";

async function openStore(): Promise<SettingsStore> {
  return SettingsStore.open({
    backend: new MemorySettingsBackend(),
    channel: null,
    mirror: null,
    lifecycle: null,
    flushDelayMs: 60_000,
  });
}

describe("tool defaults actions", () => {
  let store: SettingsStore;

  beforeEach(async () => {
    store = await openStore();
  });

  afterEach(async () => {
    await store.dispose();
  });

  it("copies every toolbar setting into the defaults tree", () => {
    store.set("tools.brush.size", 37);
    store.set("tools.floodMode", "Global");
    store.set("tools.primaryColor", { r: 1, g: 2, b: 3, a: 255 });
    loadToolbarIntoDefaults(store);
    expect(store.get("toolDefaults.brush.size")).toBe(37);
    expect(store.get("toolDefaults.floodMode")).toBe("Global");
    expect(store.get("toolDefaults.primaryColor")).toEqual({ r: 1, g: 2, b: 3, a: 255 });
  });

  it("resets every tool default to its factory value", () => {
    store.set("toolDefaults.brush.size", 50);
    store.set("toolDefaults.activeTool", "pencil");
    resetToolDefaults(store);
    expect(store.get("toolDefaults.brush.size")).toBe(2);
    expect(store.get("toolDefaults.activeTool")).toBe("paintbrush");
  });

  it("leaves the live toolbar alone when the defaults are reset", () => {
    store.set("tools.brush.size", 9);
    resetToolDefaults(store);
    expect(store.get("tools.brush.size")).toBe(9);
  });
});
