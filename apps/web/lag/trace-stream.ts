/// <reference types="node" />
import { createReadStream } from "node:fs";
import type { TraceEvent } from "./analyze.ts";

/**
 * Splits a Chrome trace in JSON (`{"traceEvents": [...]}` or a bare `[...]`) into the raw text of
 * its events while it streams, so a trace of hundreds of megabytes never has to be one string.
 * `onEvent` gets the text of each event object.
 */
export class TraceEventSplitter {
  #depth = 0;
  #eventsDepth: number | undefined;
  #inString = false;
  #escape = false;
  #lastString = "";
  #stringStart = -1;
  #pendingString = "";
  #pending = "";
  #capturing = false;
  readonly onEvent: (raw: string) => void;

  constructor(onEvent: (raw: string) => void) {
    this.onEvent = onEvent;
  }

  push(chunk: string): void {
    let captureFrom = this.#capturing ? 0 : -1;
    if (this.#inString && this.#stringStart >= 0) this.#stringStart = 0;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      if (this.#inString) {
        if (this.#escape) this.#escape = false;
        else if (c === 92 /* \ */) this.#escape = true;
        else if (c === 34 /* " */) {
          this.#inString = false;
          if (this.#stringStart >= 0) {
            this.#lastString = this.#pendingString + chunk.slice(this.#stringStart, i);
            this.#pendingString = "";
            this.#stringStart = -1;
          }
        }
        continue;
      }
      switch (c) {
        case 34 /* " */:
          this.#inString = true;
          // Only the keys of the top-level object matter (to find "traceEvents").
          if (this.#depth === 1 && this.#eventsDepth === undefined) {
            this.#stringStart = i + 1;
            this.#pendingString = "";
          }
          break;
        case 123 /* { */:
        case 91 /* [ */:
          this.#depth++;
          if (this.#eventsDepth === undefined && c === 91) {
            if (this.#depth === 1) this.#eventsDepth = 1;
            else if (this.#depth === 2 && this.#lastString === "traceEvents") this.#eventsDepth = 2;
          } else if (
            c === 123 &&
            this.#eventsDepth !== undefined &&
            this.#depth === this.#eventsDepth + 1 &&
            !this.#capturing
          ) {
            this.#capturing = true;
            this.#pending = "";
            captureFrom = i;
          }
          break;
        case 125 /* } */:
        case 93 /* ] */:
          if (
            c === 125 &&
            this.#capturing &&
            this.#eventsDepth !== undefined &&
            this.#depth === this.#eventsDepth + 1
          ) {
            this.onEvent(this.#pending + chunk.slice(captureFrom, i + 1));
            this.#pending = "";
            this.#capturing = false;
            captureFrom = -1;
          } else if (c === 93 && this.#depth === this.#eventsDepth) {
            // The end of the event array: any later array is not events.
            this.#eventsDepth = -1;
          }
          this.#depth--;
          break;
      }
    }
    if (this.#capturing && captureFrom >= 0) this.#pending += chunk.slice(captureFrom);
    if (this.#inString && this.#stringStart >= 0) {
      this.#pendingString += chunk.slice(this.#stringStart);
    }
  }
}

/**
 * Reads the events of a trace file. `keep` sees each event's raw text first, so most events can be
 * skipped without parsing them.
 */
export async function readTraceEvents(
  path: string,
  keep: (raw: string) => boolean = () => true,
): Promise<TraceEvent[]> {
  const events: TraceEvent[] = [];
  const splitter = new TraceEventSplitter((raw) => {
    if (!keep(raw)) return;
    try {
      events.push(JSON.parse(raw) as TraceEvent);
    } catch {
      // A truncated last event (the trace stopped mid-write) is skipped.
    }
  });
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 20 });
  for await (const chunk of stream) splitter.push(chunk as string);
  return events;
}

/** The trace event names and categories the analysis reads. Everything else is skipped unparsed. */
const KEEP =
  /"ph":\s*"M"|"(?:RunTask|ThreadControllerImpl::RunTask|Profile|ProfileChunk|TracingStartedInBrowser|TracingSessionIdForWorker)"|blink\.user_timing/;

export function isAnalyzedEvent(raw: string): boolean {
  return KEEP.test(raw);
}
