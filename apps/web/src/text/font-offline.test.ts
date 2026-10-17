import { describe, expect, it } from "vitest";
import {
  connectionSavesData,
  type FontPrefetchPorts,
  INPUT_QUIET_MS,
  InputActivity,
  prefetchFonts,
} from "./font-offline";

/** Ports over an in-memory cache, recording the order of events. */
function fakePorts(cached: Iterable<string>, options: { busyFor?: number; failOn?: string } = {}) {
  const cache = new Set(cached);
  const log: string[] = [];
  let busyChecks = options.busyFor ?? 0;
  let active = 0;
  let maxActive = 0;
  const ports: FontPrefetchPorts = {
    isCached: async (url) => cache.has(url),
    async download(url) {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      if (url === options.failOn) throw new Error("offline");
      cache.add(url);
      log.push(`download ${url}`);
    },
    idle: async () => {
      log.push("idle");
    },
    busy: () => {
      if (busyChecks > 0) {
        busyChecks--;
        return true;
      }
      return false;
    },
    wait: async () => {
      log.push("wait");
    },
  };
  return { ports, cache, log, maxActive: () => maxActive };
}

describe("background font download", () => {
  it("downloads every file not cached yet, a few at a time, each after an idle period", async () => {
    const urls = ["/a.woff2", "/b.woff2", "/c.woff2", "/d.otf", "/e.woff2"];
    const fake = fakePorts(["/b.woff2"]);
    const result = await prefetchFonts(urls, fake.ports, 2);
    expect(result).toEqual({ downloaded: 4, cached: 1, interrupted: false });
    expect([...fake.cache].sort()).toEqual([...urls].sort());
    expect(fake.maxActive()).toBe(2);
    const downloads = fake.log.filter((entry) => entry.startsWith("download")).length;
    expect(fake.log.filter((entry) => entry === "idle").length).toBe(downloads);
  });

  it("waits while the user interacts", async () => {
    const fake = fakePorts([], { busyFor: 3 });
    await prefetchFonts(["/a.woff2"], fake.ports, 1);
    expect(fake.log).toEqual([
      "idle",
      "wait",
      "idle",
      "wait",
      "idle",
      "wait",
      "idle",
      "download /a.woff2",
    ]);
  });

  it("stops at the first failed download and resumes with the rest in the next session", async () => {
    const urls = ["/a.woff2", "/b.woff2", "/c.woff2"];
    const first = fakePorts([], { failOn: "/b.woff2" });
    const interrupted = await prefetchFonts(urls, first.ports, 1);
    expect(interrupted).toEqual({ downloaded: 1, cached: 0, interrupted: true });
    expect([...first.cache]).toEqual(["/a.woff2"]);

    const next = fakePorts(first.cache);
    expect(await prefetchFonts(urls, next.ports, 1)).toEqual({
      downloaded: 2,
      cached: 1,
      interrupted: false,
    });
  });

  it("skips the download when the connection asks to save data", () => {
    expect(connectionSavesData(undefined)).toBe(false);
    expect(connectionSavesData({ saveData: false, effectiveType: "4g", type: "wifi" })).toBe(false);
    expect(connectionSavesData({ saveData: true })).toBe(true);
    expect(connectionSavesData({ type: "cellular" })).toBe(true);
    expect(connectionSavesData({ effectiveType: "2g" })).toBe(true);
  });

  it("counts pointer, wheel and key input as recent for a second", () => {
    const target = new EventTarget();
    let now = 10_000;
    const input = new InputActivity(target, () => now);
    expect(input.recent).toBe(false);
    target.dispatchEvent(new Event("keydown"));
    expect(input.recent).toBe(true);
    now += INPUT_QUIET_MS;
    expect(input.recent).toBe(false);
    target.dispatchEvent(new Event("pointermove"));
    expect(input.recent).toBe(true);
  });
});
