// @vitest-environment node
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isAnalyzedEvent, readTraceEvents, TraceEventSplitter } from "./trace-stream.ts";

const EVENTS = [
  { name: "RunTask", ph: "X", ts: 1, dur: 2, pid: 1, tid: 2, args: {} },
  { name: 'odd "quoted" {name} [x]', ph: "I", ts: 3, pid: 1, tid: 2, args: { s: '\\}"{' } },
  {
    name: "ProfileChunk",
    ph: "P",
    ts: 4,
    pid: 1,
    tid: 2,
    args: { data: { cpuProfile: { nodes: [{ id: 1 }] } } },
  },
];

function split(text: string, size: number): unknown[] {
  const events: unknown[] = [];
  const splitter = new TraceEventSplitter((raw) => events.push(JSON.parse(raw)));
  for (let index = 0; index < text.length; index += size)
    splitter.push(text.slice(index, index + size));
  return events;
}

describe("TraceEventSplitter", () => {
  const object = JSON.stringify({
    metadata: { traceEvents: "not this", list: [{ a: 1 }] },
    traceEvents: EVENTS,
    after: [{ not: "an event" }],
  });

  it("finds the events of the object format, however the text is chunked", () => {
    for (const size of [1, 2, 3, 7, 64, object.length]) expect(split(object, size)).toEqual(EVENTS);
  });

  it("reads the bare array format", () => {
    const array = `[\n${EVENTS.map((event) => JSON.stringify(event)).join(",\n")}\n]`;
    for (const size of [1, 5, array.length]) expect(split(array, size)).toEqual(EVENTS);
  });
});

describe("readTraceEvents", () => {
  it("streams a trace file and parses only the events the filter keeps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lag-trace-"));
    const path = join(dir, "trace.json");
    writeFileSync(path, JSON.stringify({ traceEvents: EVENTS }));
    const events = await readTraceEvents(path, isAnalyzedEvent);
    expect(events.map((event) => event.name)).toEqual(["RunTask", "ProfileChunk"]);
    // A trace cut off inside its last event, as when the browser stopped writing.
    writeFileSync(path, JSON.stringify({ traceEvents: EVENTS }).slice(0, -4));
    expect((await readTraceEvents(path)).map((event) => event.name)).toEqual([
      "RunTask",
      'odd "quoted" {name} [x]',
    ]);
  });

  it("keeps the events the analysis reads", () => {
    expect(isAnalyzedEvent('{"name":"thread_name","ph":"M"}')).toBe(true);
    expect(isAnalyzedEvent('{"cat":"blink.user_timing","name":"x"}')).toBe(true);
    expect(isAnalyzedEvent('{"name":"Profile","ph":"P"}')).toBe(true);
    expect(isAnalyzedEvent('{"name":"TracingSessionIdForWorker"}')).toBe(true);
    expect(isAnalyzedEvent('{"name":"UpdateCounters","cat":"devtools.timeline"}')).toBe(false);
  });
});
