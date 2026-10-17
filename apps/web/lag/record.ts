/// <reference types="node" />
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { type Browser, type CDPSession, chromium, type Page } from "@playwright/test";
import { CHROMIUM_WEBGPU_ARGS } from "../playwright.config.ts";
import type { PerfSnapshot } from "../src/perf/stats.ts";
import {
  type AppRecording,
  analyze,
  type CallFrame,
  CLOCK_MARK,
  type FrameResolver,
  plainResolver,
  type ResolvedFrame,
  type ToolChange,
  type TraceEvent,
} from "./analyze.ts";
import { autoSession } from "./auto.ts";
import { appUrl, defaultSessionFolder, type LagOptions, parseOptions, USAGE } from "./options.ts";
import { installToolTracker } from "./page-hooks.ts";
import { formatReport, type SessionInfo } from "./report.ts";
import { type AppServer, REPO_ROOT, startServer } from "./server.ts";
import { SourceMapResolver } from "./source-map.ts";
import { isAnalyzedEvent, readTraceEvents } from "./trace-stream.ts";

/**
 * `pnpm lag`: records a real session of the app in a visible Chromium window, then writes the
 * trace and a report of every lag spike (see lag/README.md).
 */

/** The trace categories of a DevTools performance recording, plus the CPU sampler. */
export const TRACE_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.timeline.stack",
  "disabled-by-default-devtools.target-rundown",
  "disabled-by-default-devtools.v8-source-rundown",
  "disabled-by-default-v8.cpu_profiler",
  "v8.execute",
  "blink.console",
  "blink.user_timing",
  "loading",
  "latencyInfo",
];

/** The browser keeps at most this much trace; the session ends when it is full. */
const TRACE_BUFFER_KB = 768 * 1024;

/** A long session makes a big trace: warn after this long, then every `WARN_EVERY_MS`. */
const WARN_AFTER_MS = 10 * 60_000;
const WARN_EVERY_MS = 5 * 60_000;

/** How often the app's own recording is collected, so little is lost if the window is closed. */
const COLLECT_MS = 2000;

const WINDOW = { width: 1600, height: 1000 };

interface SavedSession {
  readonly info: SessionInfo;
  readonly app: AppRecording;
  /** Frames resolved through source maps when the session was recorded, by `frameKey`. */
  readonly frames: Record<string, ResolvedFrame>;
}

function frameKey(frame: CallFrame): string {
  return `${frame.url}:${frame.lineNumber}:${frame.columnNumber}:${frame.functionName}`;
}

function log(line: string): void {
  console.log(`[lag] ${line}`);
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((done) => setTimeout(() => done(fallback), ms))]);
}

/** Collects the perf monitor's data and the tool log from the page, a part at a time. */
class AppCollector {
  readonly presents: AppRecording["presents"][number][] = [];
  readonly inputs: AppRecording["inputs"][number][] = [];
  readonly longTasks: AppRecording["longTasks"][number][] = [];
  readonly longFrames: AppRecording["longFrames"][number][] = [];
  readonly tools: ToolChange[] = [];
  clockTime: number | undefined;
  readyTime: number | undefined;
  /** The engine's backend, as the canvas reports it. */
  backend: string | undefined;
  #pending: Promise<void> | undefined;
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  collect(): Promise<void> {
    this.#pending ??= this.#collect().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  async #collect(): Promise<void> {
    if (this.page.isClosed()) return;
    const part = await this.page
      .evaluate(async () => ({
        perf: (await window.__openpaintPerf?.take()) as PerfSnapshot | undefined,
        tools: window.__lagTools?.splice(0) ?? [],
        backend:
          document.querySelector("[data-backend]")?.getAttribute("data-backend") ?? undefined,
      }))
      .catch(() => undefined);
    if (part === undefined) return;
    this.tools.push(...part.tools);
    if (part.backend) this.backend = part.backend;
    if (part.perf === undefined) return;
    this.presents.push(...part.perf.presents);
    this.inputs.push(...part.perf.inputs);
    this.longTasks.push(...part.perf.longTasks);
    this.longFrames.push(...part.perf.longFrames);
  }

  recording(): AppRecording {
    return {
      presents: this.presents,
      inputs: this.inputs,
      longTasks: this.longTasks,
      longFrames: this.longFrames,
      tools: this.tools,
      clockTime: this.clockTime,
      ...(this.readyTime !== undefined && { readyTime: this.readyTime }),
    };
  }
}

async function startTracing(cdp: CDPSession): Promise<void> {
  await cdp.send("Tracing.start", {
    transferMode: "ReturnAsStream",
    streamFormat: "json",
    streamCompression: "none",
    bufferUsageReportingInterval: 2000,
    traceConfig: {
      recordMode: "recordUntilFull",
      traceBufferSizeInKb: TRACE_BUFFER_KB,
      includedCategories: TRACE_CATEGORIES,
    },
  });
}

/** Ends tracing and streams the trace into `path`. False when the browser is gone. */
async function stopTracing(cdp: CDPSession, browser: Browser, path: string): Promise<boolean> {
  if (!browser.isConnected()) return false;
  try {
    const complete = new Promise<{ stream?: string }>((done) =>
      cdp.once("Tracing.tracingComplete", (event) => done(event)),
    );
    await cdp.send("Tracing.end");
    const { stream } = await complete;
    if (stream === undefined) return false;
    const file = createWriteStream(path);
    let bytes = 0;
    for (;;) {
      const chunk = await cdp.send("IO.read", { handle: stream, size: 8 << 20 });
      const data = chunk.base64Encoded ? Buffer.from(chunk.data, "base64") : chunk.data;
      bytes += data.length;
      if (!file.write(data)) await new Promise((done) => file.once("drain", done));
      if (chunk.eof) break;
    }
    await cdp.send("IO.close", { handle: stream });
    await new Promise<void>((done, fail) =>
      file.end((error?: Error | null) => (error ? fail(error) : done())),
    );
    log(`trace: ${(bytes / 1e6).toFixed(1)} MB`);
    return true;
  } catch (error) {
    log(`could not save the trace: ${(error as Error).message}`);
    return false;
  }
}

/** The script URLs of the profiled code, for the source maps. */
function profiledUrls(events: readonly TraceEvent[]): Set<string> {
  const urls = new Set<string>();
  for (const event of events) {
    if (event.name !== "ProfileChunk") continue;
    const nodes = (
      event.args?.data as { cpuProfile?: { nodes?: { callFrame: CallFrame }[] } } | undefined
    )?.cpuProfile?.nodes;
    for (const node of nodes ?? []) if (node.callFrame.url) urls.add(node.callFrame.url);
  }
  return urls;
}

async function fetchText(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url);
    return response.ok ? await response.text() : undefined;
  } catch {
    return undefined;
  }
}

/** Remembers every frame it resolves, so `--analyze` can reuse them without the server. */
function recordingResolver(
  inner: FrameResolver,
  frames: Record<string, ResolvedFrame>,
): FrameResolver {
  return (frame) => {
    const resolved = inner(frame);
    frames[frameKey(frame)] = resolved;
    return resolved;
  };
}

async function writeReport(
  dir: string,
  events: readonly TraceEvent[],
  saved: SavedSession,
  resolve: FrameResolver,
) {
  const analysis = analyze(events, saved.app, { resolve });
  const report = formatReport(analysis, saved.info);
  writeFileSync(join(dir, "report.md"), report);
  return analysis;
}

function printSummary(dir: string, analysis: ReturnType<typeof analyze>): void {
  const main = analysis.taskSummary.find((entry) => entry.thread === "main");
  const worst = [...analysis.incidents].sort((a, b) => b.durationMs - a.durationMs)[0];
  log(
    `${analysis.incidents.length} lag spikes in ${(analysis.sessionMs / 1000).toFixed(1)} s; main-thread long tasks ${Math.round(main?.longTaskMs ?? 0)} ms` +
      (worst ? `; worst ${Math.round(worst.durationMs)} ms` : ""),
  );
  log(`report: ${join(dir, "report.md")}`);
  log(
    `trace:  ${join(dir, "trace.json")} (open in Chrome DevTools > Performance, or https://ui.perfetto.dev)`,
  );
}

/** `--analyze <dir>`: writes the report again from a saved recording. */
async function reanalyze(dir: string): Promise<void> {
  const saved = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as SavedSession;
  const tracePath = join(dir, "trace.json");
  const events = existsSync(tracePath) ? await readTraceEvents(tracePath, isAnalyzedEvent) : [];
  const resolve: FrameResolver = (frame) => saved.frames[frameKey(frame)] ?? plainResolver(frame);
  printSummary(dir, await writeReport(dir, events, saved, resolve));
}

async function record(options: LagOptions): Promise<void> {
  const date = new Date();
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const dir = options.out ? resolve(cwd, options.out) : join(REPO_ROOT, defaultSessionFolder(date));
  mkdirSync(dir, { recursive: true });

  let server: AppServer | undefined;
  let browser: Browser | undefined;
  const notes: string[] = [];
  try {
    server = options.url === undefined ? await startServer(options.dev) : undefined;
    const base = options.url ?? (server as AppServer).url;
    const url = appUrl(base, options.engine, options.auto);
    browser = await chromium.launch({
      headless: options.auto,
      channel: "chromium",
      args: [...CHROMIUM_WEBGPU_ARGS, `--window-size=${WINDOW.width},${WINDOW.height}`],
      // The session decides what Ctrl+C does: it ends the recording, then closes the browser.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    const context = await browser.newContext({
      viewport: options.auto ? { width: 1440, height: 900 } : null,
    });
    const page = await context.newPage();
    await page.addInitScript(installToolTracker);
    const cdp = await browser.newBrowserCDPSession();
    await startTracing(cdp);
    const startedAt = Date.now();
    const collector = new AppCollector(page);

    // Every way to end the session is armed before the page loads, so closing it early still saves.
    let finished = false;
    let end: (reason: string) => void = () => {};
    const ended = new Promise<string>((done) => {
      end = (reason) => {
        finished = true;
        done(reason);
      };
    });
    let warnedFull = false;
    const terminal = options.auto ? undefined : createInterface({ input: process.stdin });
    terminal?.once("line", () => end("Enter in the terminal"));
    page.on("close", () => end("the browser window was closed"));
    browser.on("disconnected", () => end("the browser exited"));
    process.on("SIGINT", () => {
      end("Ctrl+C");
      // A second Ctrl+C gives up on the report.
      process.once("SIGINT", () => process.exit(130));
    });
    cdp.on("Tracing.bufferUsage", (event: { percentFull?: number }) => {
      const full = event.percentFull ?? 0;
      if (full >= 0.99) end("the trace buffer was full");
      else if (full >= 0.8 && !warnedFull) {
        warnedFull = true;
        log(
          `the trace buffer is ${Math.round(full * 100)} % full; the session ends when it is full.`,
        );
      }
    });

    log(`recording ${url}`);
    const started = (async () => {
      await page.goto(url);
      await page.waitForFunction(() => window.__openpaintPerf !== undefined, null, {
        timeout: 120_000,
      });
      collector.clockTime = await page.evaluate(
        (name) => performance.mark(name).startTime,
        CLOCK_MARK,
      );
      collector.readyTime = await page
        .waitForFunction(
          () =>
            document.querySelector("[data-backend]")?.getAttribute("data-backend")
              ? performance.now()
              : undefined,
          null,
          { timeout: 120_000 },
        )
        .then((handle) => handle.jsonValue())
        .catch(() => undefined);
    })();
    const startup = await Promise.race([
      started.then(
        () => undefined,
        (error: Error) => error,
      ),
      ended.then(() => undefined),
    ]);
    if (startup instanceof Error) {
      if (page.isClosed() || !browser.isConnected())
        notes.push("The session ended before the app had loaded.");
      else throw startup;
    }
    if (finished) log("the session ended while the app was loading.");
    else if (options.auto) {
      autoSession(page, log).then(
        () => end("the scripted session finished (--auto)"),
        (error: Error) => {
          notes.push(`The scripted session failed: ${error.message.split("\n")[0]}`);
          end("the scripted session failed (--auto)");
        },
      );
    } else {
      log("use the app now. Press Enter here (or close the window, or Ctrl+C) to finish.");
    }
    const collecting = setInterval(() => void collector.collect(), COLLECT_MS);
    let warnAt = WARN_AFTER_MS;
    const warning = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      if (elapsed < warnAt) return;
      warnAt += WARN_EVERY_MS;
      log(
        `recording for ${Math.round(elapsed / 60_000)} min: the trace is getting large. Press Enter to finish.`,
      );
    }, 10_000);

    const reason = await ended;
    terminal?.close();
    clearInterval(collecting);
    clearInterval(warning);
    log(`session ended: ${reason}. Saving...`);
    await withTimeout(collector.collect(), 10_000, undefined);
    if (page.isClosed()) {
      notes.push(
        "The window was closed, so up to the last 2 s of the app's own recording (frames, presents, input) is missing.",
      );
    }
    const tracePath = join(dir, "trace.json");
    const traced = await stopTracing(cdp, browser, tracePath);
    if (!traced)
      notes.push(
        "The trace could not be saved (the browser exited), so only the app's own recording is used.",
      );
    const events = traced ? await readTraceEvents(tracePath, isAnalyzedEvent) : [];
    const resolver = new SourceMapResolver(fetchText, REPO_ROOT);
    await resolver.load(profiledUrls(events));
    const browserName = `Chromium ${browser.version()}${options.auto ? " (headless)" : ""}`;
    await browser.close().catch(() => {});
    browser = undefined;
    server?.stop();
    server = undefined;

    const mode = options.url
      ? `an existing server at ${options.url}`
      : options.dev
        ? "the Vite dev server (pnpm dev): unbundled modules, React development mode"
        : "a production build with source maps, served by vite preview";
    const frames: Record<string, ResolvedFrame> = {};
    const saved: SavedSession = {
      info: {
        date: date.toISOString(),
        url,
        engine: options.engine,
        mode,
        browser: browserName,
        backend: collector.backend,
        ended: reason,
        sourceMaps: `${resolver.mapped} of ${resolver.scripts} profiled scripts had a source map${options.dev ? "" : " (bundle frames without one show bundle positions)"}`,
        notes,
      },
      app: collector.recording(),
      frames,
    };
    const analysis = await writeReport(
      dir,
      events,
      saved,
      recordingResolver(resolver.resolve, frames),
    );
    writeFileSync(join(dir, "session.json"), JSON.stringify(saved));
    const shown = relative(cwd, dir);
    printSummary(shown === "" || shown.startsWith("..") ? dir : shown, analysis);
  } finally {
    await browser?.close().catch(() => {});
    server?.stop();
  }
}

async function main(): Promise<void> {
  let options: LagOptions;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (options.analyze !== undefined) {
    await reanalyze(resolve(process.env.INIT_CWD ?? process.cwd(), options.analyze));
    return;
  }
  await record(options);
}

main().then(
  () => process.exit(0),
  (error: Error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  },
);
