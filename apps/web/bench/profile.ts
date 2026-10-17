/// <reference types="node" />
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CDPSession, Page } from "@playwright/test";
import { HAS_CDP } from "./browser.ts";

/**
 * With `BENCH_PROFILE=<dir>`, a scenario records a main-thread CPU profile of its gesture into
 * `<dir>/<id>.cpuprofile` (open it in DevTools › Performance) and prints the functions with the most
 * self time. Use it with `BENCH_DEV=1` for readable names.
 */
const PROFILE_DIR = process.env.BENCH_PROFILE;

interface ProfileNode {
  readonly id: number;
  readonly callFrame: {
    readonly functionName: string;
    readonly url: string;
    readonly lineNumber: number;
  };
}

interface CpuProfile {
  readonly nodes: readonly ProfileNode[];
  readonly samples?: readonly number[];
  readonly timeDeltas?: readonly number[];
}

export class GestureProfile {
  readonly #session: CDPSession;

  private constructor(session: CDPSession) {
    this.#session = session;
  }

  /** Starts a profile when `BENCH_PROFILE` is set. */
  static async start(page: Page): Promise<GestureProfile | undefined> {
    if (PROFILE_DIR === undefined || !HAS_CDP) return undefined;
    const session = await page.context().newCDPSession(page);
    await session.send("Profiler.enable");
    await session.send("Profiler.setSamplingInterval", { interval: 250 });
    await session.send("Profiler.start");
    return new GestureProfile(session);
  }

  /** Stops the profile, saves it and prints its top self-time functions. */
  async stop(id: string): Promise<void> {
    if (PROFILE_DIR === undefined) return;
    const { profile } = (await this.#session.send("Profiler.stop")) as { profile: CpuProfile };
    await this.#session.detach();
    mkdirSync(PROFILE_DIR, { recursive: true });
    writeFileSync(join(PROFILE_DIR, `${id}.cpuprofile`), JSON.stringify(profile));
    console.log(`\n${id} main-thread self time:\n${topSelfTime(profile, 25)}`);
  }
}

/** The `count` functions with the most self time, one per line. */
export function topSelfTime(profile: CpuProfile, count: number): string {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const totals = new Map<string, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  let all = 0;
  samples.forEach((id, index) => {
    const node = byId.get(id);
    if (node === undefined) return;
    const { functionName, url, lineNumber } = node.callFrame;
    const file = url.split("/").pop() ?? url;
    const key = `${functionName || "(anonymous)"} ${file}:${lineNumber + 1}`;
    const ms = (deltas[index + 1] ?? deltas[index] ?? 0) / 1000;
    all += ms;
    totals.set(key, (totals.get(key) ?? 0) + ms);
  });
  return [...totals]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(
      ([key, ms]) =>
        `${ms.toFixed(1).padStart(8)} ms ${((100 * ms) / all).toFixed(1).padStart(5)} %  ${key}`,
    )
    .join("\n");
}
