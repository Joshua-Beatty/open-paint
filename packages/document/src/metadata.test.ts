import { describe, expect, it } from "vitest";
import { MetadataMap, MetadataStore } from "./metadata";

describe("MetadataMap", () => {
  it("compares names ordinally and case-insensitively, keeping the first spelling", () => {
    const map = new MetadataMap<string>();
    map.set("Camera", "a");
    expect(map.get("camera")).toBe("a");
    expect(map.has("CAMERA")).toBe(true);
    map.set("camera", "b");
    expect(map.size).toBe(1);
    expect(map.get("Camera")).toBe("b");
    expect([...map.entries()]).toEqual([["camera", "b"]]);
  });

  it("keeps insertion order and replaces values in place", () => {
    const map = new MetadataMap<string>();
    map.set("one", "1");
    map.set("two", "2");
    map.set("ONE", "uno");
    expect([...map.entries()]).toEqual([
      ["ONE", "uno"],
      ["two", "2"],
    ]);
  });

  it("deletes entries", () => {
    const map = new MetadataMap<string>();
    map.set("key", "value");
    expect(map.delete("KEY")).toBe(true);
    expect(map.delete("key")).toBe(false);
    expect(map.size).toBe(0);
  });

  it("clones binary values so the copy is independent", () => {
    const map = new MetadataMap<Uint8Array | string>();
    map.set("exif", new Uint8Array([1, 2, 3]));
    const copy = map.clone();
    const original = map.get("exif") as Uint8Array;
    original[0] = 9;
    expect(copy.get("exif")).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("MetadataStore", () => {
  it("holds the four sections of DOC-DOC-04", () => {
    const store = new MetadataStore();
    store.exif.set("Make", "Maker");
    store.iptc.set("Caption", new Uint8Array([7]));
    store.xmp.set("0", "<x:xmpmeta/>");
    store.user.set("app", "value");
    store.xmlHeader = "<header/>";
    expect(store.exif.get("make")).toBe("Maker");
    expect(store.xmp.get("0")).toBe("<x:xmpmeta/>");
    expect(store.user.get("APP")).toBe("value");
  });

  it("clones every section and the XML header", () => {
    const store = new MetadataStore();
    store.exif.set("Make", new Uint8Array([1]));
    store.user.set("key", "value");
    store.xmlHeader = "<header/>";
    const copy = store.clone();
    store.user.set("key", "changed");
    store.xmlHeader = "other";
    expect(copy.user.get("key")).toBe("value");
    expect(copy.xmlHeader).toBe("<header/>");
    expect(copy.exif.get("make")).toEqual(new Uint8Array([1]));
  });
});
