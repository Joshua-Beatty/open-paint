/** The command line of `pnpm lag`. */
export interface LagOptions {
  /** Serve the app with the Vite dev server instead of a production build and `vite preview`. */
  readonly dev: boolean;
  /** `?engine=`: v1 or v2. */
  readonly engine: "v1" | "v2";
  /** Attach to an app that is already being served here, instead of starting a server. */
  readonly url: string | undefined;
  /** Where the recording goes. Defaults to `.perf/lag/<timestamp>/` in the repository. */
  readonly out: string | undefined;
  /** Re-analyze an earlier recording in this folder instead of recording. */
  readonly analyze: string | undefined;
  /** Hidden: drive a short scripted session headless and end it (the smoke test). */
  readonly auto: boolean;
  readonly help: boolean;
}

export const USAGE = `Usage: pnpm lag [options]

Opens OpenPaint in a visible Chromium window and records everything until you close the window,
press Enter in this terminal or press Ctrl+C. Then writes trace.json and report.md.

Options:
  --dev               Use the Vite dev server (readable names, no build) instead of a production build
  --engine v1|v2      The engine to run (default v1)
  --url <url>         Attach to an app that is already served there (no server is started)
  --out <dir>         Output folder (default .perf/lag/<timestamp>/ in the repository)
  --analyze <dir>     Write report.md again from an earlier recording's trace.json and session.json
  --help              Show this help
`;

export function parseOptions(argv: readonly string[]): LagOptions {
  const options = {
    dev: false,
    engine: "v1" as "v1" | "v2",
    url: undefined as string | undefined,
    out: undefined as string | undefined,
    analyze: undefined as string | undefined,
    auto: false,
    help: false,
  };
  const args = argv.filter((arg) => arg !== "--");
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? arg.split(/=(.*)/s) : [arg];
    const value = () => {
      if (inline !== undefined) return inline;
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value.`);
      index++;
      return next;
    };
    switch (flag) {
      case "--dev":
        options.dev = true;
        break;
      case "--engine": {
        const engine = value();
        if (engine !== "v1" && engine !== "v2")
          throw new Error(`--engine must be v1 or v2, not "${engine}".`);
        options.engine = engine;
        break;
      }
      case "--url":
        options.url = new URL(value()).href;
        break;
      case "--out":
        options.out = value();
        break;
      case "--analyze":
        options.analyze = value();
        break;
      case "--auto":
        options.auto = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option "${arg}".\n\n${USAGE}`);
    }
  }
  if (options.dev && options.url !== undefined)
    throw new Error("--dev and --url cannot be combined.");
  return options;
}

/** The app URL with the perf instrumentation on. */
export function appUrl(base: string, engine: string, bench: boolean): string {
  const url = new URL("/", base);
  url.searchParams.set("perf", "1");
  if (bench) url.searchParams.set("bench", "1");
  url.searchParams.set("engine", engine);
  return url.href;
}

/** The default recording folder, relative to the repository root (gitignored). */
export const LAG_DIR = ".perf/lag";

/** The default folder of a session, relative to the repository root. */
export function defaultSessionFolder(date: Date): string {
  return `${LAG_DIR}/${sessionFolderName(date)}`;
}

/** A folder name for a session: the ISO time, safe on Windows. */
export function sessionFolderName(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replaceAll(":", "-");
}
