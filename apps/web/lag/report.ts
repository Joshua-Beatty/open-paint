import {
  type FunctionTime,
  type Incident,
  LAG_MS,
  type LagAnalysis,
  type Spike,
  type ThreadAttribution,
  type ThreadName,
} from "./analyze.ts";

/** What the recorder knows about the session, for the report's header. */
export interface SessionInfo {
  readonly date: string;
  readonly url: string;
  readonly engine: string;
  /** How the app was served, e.g. "production build (vite preview)". */
  readonly mode: string;
  readonly browser: string;
  readonly backend: string | undefined;
  /** Why the session ended. */
  readonly ended: string;
  /** e.g. "12 of 14 scripts source-mapped". */
  readonly sourceMaps: string;
  readonly notes: readonly string[];
}

const THREAD_LABEL: Record<ThreadName, string> = { main: "main", engine: "engine worker" };

/** `m:ss.SSS` from the start of the session. */
export function formatOffset(ms: number): string {
  const total = Math.max(0, ms);
  const minutes = Math.floor(total / 60_000);
  const seconds = (total - minutes * 60_000) / 1000;
  return `${minutes}:${seconds.toFixed(3).padStart(6, "0")}`;
}

export function formatMs(ms: number): string {
  return ms >= 100 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`;
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function describeSpike(spike: Spike): string {
  const where = THREAD_LABEL[spike.thread];
  switch (spike.kind) {
    case "task":
      return `long task ${formatMs(spike.durationMs)} on ${where}`;
    case "frame":
      return `long animation frame ${formatMs(spike.durationMs)} (blocking ${formatMs(spike.extra ?? 0)})`;
    case "present-gap":
      return `no present for ${formatMs(spike.durationMs)} during input`;
    case "latency":
      return `input-to-present latency ${formatMs(spike.durationMs)} (${spike.extra ?? 1} input${spike.extra === 1 ? "" : "s"} ≥ ${LAG_MS} ms)`;
  }
}

/** Up to this many signals are listed inline; more get a summary and a table. */
const SIGNALS_INLINE = 3;
const SIGNALS_LISTED = 40;

const KIND_LABEL: Record<Spike["kind"], string> = {
  task: "long task",
  frame: "long animation frame",
  "present-gap": "present gap",
  latency: "input latency spike",
};

/** e.g. "11 long animation frames (worst 150 ms), 2 long tasks on main (worst 51 ms)". */
export function summarizeSpikes(spikes: readonly Spike[]): string {
  const groups = new Map<string, { count: number; worst: number }>();
  for (const spike of spikes) {
    const key =
      spike.kind === "task"
        ? `${KIND_LABEL.task}|${THREAD_LABEL[spike.thread]}`
        : KIND_LABEL[spike.kind];
    const group = groups.get(key) ?? { count: 0, worst: 0 };
    group.count++;
    group.worst = Math.max(group.worst, spike.durationMs);
    groups.set(key, group);
  }
  return [...groups]
    .map(([key, { count, worst }]) => {
      const [label, thread] = key.split("|");
      const plural = count === 1 ? label : `${label}s`;
      return `${count} ${plural}${thread ? ` on ${thread}` : ""} (worst ${formatMs(worst)})`;
    })
    .join(", ");
}

/** The incident's headline: its longest spike. */
function headline(incident: Incident): string {
  const worst = [...incident.spikes].sort((a, b) => b.durationMs - a.durationMs)[0];
  if (worst === undefined) return "";
  const more = incident.spikes.length - 1;
  return more > 0 ? `${describeSpike(worst)} (+${more} more)` : describeSpike(worst);
}

function topFunction(incident: Incident): string {
  const thread = incident.threads.find((entry) => entry.thread === incident.thread);
  const top = thread?.self[0];
  return top === undefined
    ? "–"
    : `${top.name} (${top.location || top.origin}) ${formatMs(top.ms)}`;
}

function functionTable(title: string, list: readonly FunctionTime[], totalMs: number): string[] {
  if (list.length === 0) return [];
  const lines = [
    `${title}:`,
    "",
    "| Function | Location | Origin | Time | Share |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const entry of list) {
    const share = totalMs > 0 ? `${Math.round((entry.ms / totalMs) * 100)} %` : "–";
    lines.push(
      `| ${cell(entry.name)} | ${cell(entry.location || "–")} | ${entry.origin} | ${formatMs(entry.ms)} | ${share} |`,
    );
  }
  lines.push("");
  return lines;
}

function attributionLines(
  attribution: ThreadAttribution,
  windowMs: number,
  heading: string,
): string[] {
  const label = THREAD_LABEL[attribution.thread];
  const share =
    windowMs > 0 ? ` (${Math.round((attribution.busyMs / windowMs) * 100)} % of the window)` : "";
  return [
    `${heading} ${label}: busy ${formatMs(attribution.busyMs)}${share}`,
    "",
    ...functionTable("Top self time", attribution.self, attribution.busyMs),
    ...functionTable("Top inclusive time", attribution.inclusive, attribution.busyMs),
  ];
}

function incidentLines(incident: Incident, index: number, analysis: LagAnalysis): string[] {
  const offset = (incident.start - analysis.start) / 1000;
  const windowMs = (incident.end - incident.start) / 1000;
  const lines = [
    `### ${index + 1}. ${formatOffset(offset)}: ${headline(incident)}`,
    "",
    `- **At** ${formatOffset(offset)} for ${formatMs(windowMs)} (window), worst signal ${formatMs(incident.durationMs)}`,
    `- **Thread:** ${THREAD_LABEL[incident.thread]}`,
    `- **Doing:** ${incident.activity}${incident.tool === undefined ? "" : ` · **Tool:** ${incident.tool}`}`,
    `- **Signals:** ${incident.spikes.length <= SIGNALS_INLINE ? incident.spikes.map(describeSpike).join("; ") : summarizeSpikes(incident.spikes)}`,
    "",
  ];
  if (incident.spikes.length > SIGNALS_INLINE) {
    lines.push("| At | Signal |", "| --- | --- |");
    const sorted = [...incident.spikes].sort((a, b) => a.start - b.start);
    for (const spike of sorted.slice(0, SIGNALS_LISTED)) {
      lines.push(
        `| ${formatOffset((spike.start - analysis.start) / 1000)} | ${cell(describeSpike(spike))} |`,
      );
    }
    if (sorted.length > SIGNALS_LISTED)
      lines.push(`| … | ${sorted.length - SIGNALS_LISTED} more |`);
    lines.push("");
  }
  // The lag's own thread first; the other one only when it did real work in the window.
  const threads = [...incident.threads].sort((a, b) =>
    a.thread === incident.thread ? -1 : b.thread === incident.thread ? 1 : 0,
  );
  for (const attribution of threads) {
    if (attribution.busyMs === 0) continue;
    if (attribution.thread !== incident.thread && attribution.busyMs < Math.max(5, windowMs * 0.1))
      continue;
    lines.push(...attributionLines(attribution, windowMs, "####"));
  }
  if (incident.threads.every((attribution) => attribution.busyMs === 0)) {
    lines.push("No CPU samples in this window.", "");
  }
  return lines;
}

/** The Markdown report of a lag recording. */
export function formatReport(analysis: LagAnalysis, session: SessionInfo): string {
  const { incidents } = analysis;
  const worst = [...incidents].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
  const lines: string[] = [
    `# Lag report, ${session.date}`,
    "",
    `- **App:** ${session.url}, engine ${session.engine}, backend ${session.backend ?? "unknown"}`,
    `- **Served by:** ${session.mode}`,
    `- **Browser:** ${session.browser}`,
    `- **Ended by:** ${session.ended}`,
    `- **Source maps:** ${session.sourceMaps}`,
    `- **Threads:** main ${threadId(analysis, "main")}, engine worker ${threadId(analysis, "engine")}`,
    ...session.notes.map((note) => `- **Note:** ${note}`),
    "",
    "## Summary",
    "",
    "| | |",
    "| --- | --- |",
    `| Session length | ${formatOffset(analysis.sessionMs)} |`,
    `| Lag spikes (overlapping signals grouped) | ${incidents.length} |`,
  ];
  for (const summary of analysis.taskSummary) {
    lines.push(
      `| Long tasks on ${THREAD_LABEL[summary.thread]} | ${summary.longTasks}, total ${formatMs(summary.longTaskMs)}, longest ${formatMs(summary.longestTaskMs)}, blocking ${formatMs(summary.blockingMs)} |`,
    );
  }
  lines.push(
    `| Long animation frames ≥ ${LAG_MS} ms | ${analysis.spikeCounts.frame} |`,
    `| Present gaps ≥ ${LAG_MS} ms during input | ${analysis.spikeCounts["present-gap"]} |`,
    `| Input-to-present latency ≥ ${LAG_MS} ms (one per present) | ${analysis.spikeCounts.latency} |`,
    "",
  );
  if (!analysis.clockAligned) {
    lines.push(
      "> The app's own recording could not be lined up with the trace, so long animation frames, present gaps, latency, activity and tool are missing. Only trace tasks are reported.",
      "",
    );
  }
  for (const name of ["main", "engine"] as const) {
    if (!analysis.profiled[name]) {
      lines.push(
        `> No CPU samples for the ${THREAD_LABEL[name]} thread, so it has no function attribution.`,
        "",
      );
    }
  }
  if (incidents.length === 0) {
    lines.push(`No lag spikes: nothing reached ${LAG_MS} ms.`, "");
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    "### Worst 10",
    "",
    "| # | At | Duration | What | Thread | Doing | Tool | Top self time |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const incident of worst) {
    const index = incidents.indexOf(incident);
    lines.push(
      `| [${index + 1}](#${anchor(incident, index, analysis)}) | ${formatOffset((incident.start - analysis.start) / 1000)} | ${formatMs(incident.durationMs)} | ${cell(headline(incident))} | ${THREAD_LABEL[incident.thread]} | ${cell(incident.activity)} | ${cell(incident.tool ?? "–")} | ${cell(topFunction(incident))} |`,
    );
  }
  lines.push("", "### Hot functions across all spikes", "");
  const totalWindowMs = incidents.reduce(
    (sum, incident) => sum + (incident.end - incident.start) / 1000,
    0,
  );
  for (const attribution of analysis.hot)
    lines.push(...attributionLines(attribution, totalWindowMs, "####"));
  lines.push("## All spikes", "");
  for (const [index, incident] of incidents.entries())
    lines.push(...incidentLines(incident, index, analysis));
  return `${lines.join("\n")}\n`;
}

function threadId(analysis: LagAnalysis, name: ThreadName): string {
  const thread = analysis.threads[name];
  return thread === undefined ? "not found" : `(pid ${thread.pid}, tid ${thread.tid})`;
}

/** The GitHub-style anchor of an incident's heading. */
function anchor(incident: Incident, index: number, analysis: LagAnalysis): string {
  const heading = `${index + 1}. ${formatOffset((incident.start - analysis.start) / 1000)}: ${headline(incident)}`;
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}
