# Lag recorder (`pnpm lag`)

Records a real session of the app and reports every lag spike and what caused it.

```
mise exec -- pnpm lag
```

This builds the app with source maps, serves it with `vite preview` (production COOP/COEP/CSP headers), and opens it in a visible Chromium window with WebGPU, at `/?perf=1`. Use the app normally: paint, drag selections, open effects. To finish, do one of these:

- press Enter in the terminal;
- close the browser window;
- press Ctrl+C in the terminal. A second Ctrl+C quits without writing the report.

The recording goes to `.perf/lag/<UTC time>/` at the repository root (gitignored):

| File | What |
|---|---|
| `report.md` | The lag report (see below) |
| `trace.json` | The full Chrome trace |
| `session.json` | The app's own recording and the resolved function names, so `--analyze` can rebuild the report |

## Options

| Option | Effect |
|---|---|
| `--dev` | Use the Vite dev server instead of a production build. There is no build step, and function names are the real ones. Timings include React development mode and unbundled modules, so they are slower than production. |
| `--engine v1\|v2` | The engine to run (`?engine=`). Default `v1`. |
| `--url <url>` | Attach to an app that is already being served there. No server is started. Source maps are read from that server. |
| `--out <dir>` | The output folder, relative to where you ran the command. |
| `--analyze <dir>` | Write `report.md` again from an earlier recording (for example, after changing the analysis). |

Pass options after the script name, for example `pnpm lag --dev --engine v2`.

## What it records

- **A Chrome trace** of all threads, through the DevTools protocol, with the categories of a DevTools performance recording: `devtools.timeline` (tasks, events, timers, frames), `disabled-by-default-v8.cpu_profiler` (JavaScript CPU samples on the main thread and in every worker), `blink.user_timing`, `loading`, `latencyInfo`, `v8.execute`.
- **The app's own perf monitor** (`?perf=1`, `apps/web/src/perf/perf-monitor.ts`): input timestamps (pointer samples with drag or hover, wheel, keys), engine present times, `long-animation-frame` and `longtask` entries. It is collected every 2 s, so closing the window loses at most the last 2 s of it.
- **The active tool**, read from the Tools panel's checked radio each time it changes.
- **User timing measures** that the app adds with `?perf=1`, so they show up in the trace's Timings track: `openpaint:tool pointer <phase>` (the active tool handling pointer samples), `openpaint:engine sync` (a document change sent to the engine), and `openpaint:engine present` on the engine worker (from the start of a frame to the presenter returning).

A trace grows by about 1 MB per second of use. The recorder warns after 10 minutes and then every 5 minutes. The browser keeps up to 768 MB of trace; when that is full, the session ends by itself.

## Reading the report

A **lag spike** is any of these:

- a main-thread or engine-worker task of 50 ms or more;
- a long animation frame of 50 ms or more;
- a gap between engine presents while input kept coming: the inputs after a present were owed the next one for 50 ms or more in total. Only drags and wheel bursts on the canvas count, so a pause in a drag is not lag. A drag that saw no present at all until 250 ms after it ended does not draw through the engine (for example, a selection outline on the overlay or a panel scroll); it is judged by its tasks and frames only;
- an input-to-present latency of 50 ms or more: from a drag sample or a canvas wheel event to the end of the next present. The inputs that waited for the same present are reported once, with the worst latency.

Signals that overlap in time are reported as one spike. Each spike lists:

- **At**: the offset from the start of the session (`m:ss.SSS`), the length of its window, and its worst signal.
- **Thread**: where it happened. A long task's own thread. Otherwise the main thread for a long frame, and for gaps and latency the thread that was busier in the window.
- **Doing**: the input at the time (pointer drag on canvas or UI, click, wheel, key press, hover, or none). "app loading" means the app was not ready yet. **Tool** is the active tool.
- **Top self time** and **top inclusive time**: the CPU samples of each busy thread in the window, added up per function. Our functions (origin `app` for TypeScript, `wasm` for the Rust kernels) come first, then libraries and VM entries (`(garbage collector)`, `(program)`, native calls). Locations are `file:line` of the original source, through the source maps.

The summary at the top has the session length, the long-task totals per thread, the counts per kind, the worst 10 spikes, and the functions that are hot across all spikes.

## Opening the trace

- Chrome DevTools: open DevTools on any page, go to **Performance**, and load `trace.json` with the upload button (or drag it in). Use the time offsets from the report to find a spike; the session starts at the left edge of the trace. The app's measures are in the **Timings** track.
- Perfetto: open https://ui.perfetto.dev and choose **Open trace file**.

## Limitations

- WASM functions show as `wasm-function[N]`: the release build has no name section. The inclusive table shows the JavaScript binding that called it (for example `composite_rgba8`).
- In the production build, names come from the original source next to each mapped function. A callback with no name of its own is shown as `<callee> callback` or `(anonymous)`.
- "Present" means the engine handed the frame to its presenter, not that it reached the screen.
- Input-to-present latency assumes the next present shows the input.
- The trace includes every process of the browser, so it is large. The analysis reads only the page's main thread and the engine worker.

## Code

| File | What |
|---|---|
| `record.ts` | The command: server, browser, tracing, collection, then the report |
| `analyze.ts` | Spike detection, grouping, CPU profile attribution (pure, unit-tested) |
| `report.ts` | The Markdown report |
| `source-map.ts` | Source map decoding and function names |
| `trace-stream.ts` | Streams the events out of a large trace file |
| `server.ts` | Builds and serves the app |
| `page-hooks.ts` | The tool tracker injected into the page |
| `auto.ts` | The scripted session of the hidden `--auto` flag (the smoke test) |
