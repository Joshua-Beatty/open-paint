import { posix } from "node:path";
import {
  type CallFrame,
  type FrameResolver,
  plainResolver,
  type ResolvedFrame,
  shortPath,
} from "./analyze.ts";

/** A version 3 source map (index maps with `sections` are not used by Vite). */
export interface SourceMapJson {
  readonly version: number;
  readonly sources: readonly (string | null)[];
  readonly sourceRoot?: string;
  readonly sourcesContent?: readonly (string | null)[];
  readonly names?: readonly string[];
  readonly mappings: string;
}

/** Where a generated position came from. Lines and columns are 0-based. */
export interface OriginalPosition {
  readonly source: string;
  readonly line: number;
  readonly column: number;
  readonly name: string | undefined;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUE = new Int8Array(128).fill(-1);
for (const [index, char] of [...BASE64].entries()) BASE64_VALUE[char.charCodeAt(0)] = index;

/**
 * Decodes `mappings` into one array per generated line of segments
 * `[column, source, line, column, name]` (`source` is -1 for a segment that maps nowhere).
 */
export function decodeMappings(mappings: string): Int32Array[][] {
  const lines: Int32Array[][] = [];
  let segments: Int32Array[] = [];
  let source = 0;
  let line = 0;
  let column = 0;
  let name = 0;
  let generated = 0;
  let fields: number[] = [];
  let value = 0;
  let shift = 0;
  const endSegment = () => {
    if (fields.length === 0) return;
    generated += fields[0] as number;
    if (fields.length >= 4) {
      source += fields[1] as number;
      line += fields[2] as number;
      column += fields[3] as number;
      if (fields.length >= 5) name += fields[4] as number;
      segments.push(Int32Array.of(generated, source, line, column, fields.length >= 5 ? name : -1));
    } else segments.push(Int32Array.of(generated, -1, 0, 0, -1));
    fields = [];
  };
  for (let i = 0; i < mappings.length; i++) {
    const char = mappings.charCodeAt(i);
    if (char === 44 /* , */) endSegment();
    else if (char === 59 /* ; */) {
      endSegment();
      lines.push(segments);
      segments = [];
      generated = 0;
    } else {
      const digit = BASE64_VALUE[char] ?? -1;
      if (digit < 0) throw new Error(`Invalid base64 VLQ character "${mappings[i]}".`);
      value += (digit & 31) << shift;
      if (digit & 32) shift += 5;
      else {
        const negative = value & 1;
        value >>>= 1;
        fields.push(negative ? -value : value);
        value = 0;
        shift = 0;
      }
    }
  }
  endSegment();
  lines.push(segments);
  return lines;
}

/** Looks up generated positions in one source map. */
export class SourceMap {
  readonly #lines: Int32Array[][];
  readonly map: SourceMapJson;

  constructor(map: SourceMapJson) {
    this.map = map;
    this.#lines = decodeMappings(map.mappings);
  }

  /** The original position of generated `line`, `column` (0-based), or undefined. */
  lookup(line: number, column: number): OriginalPosition | undefined {
    const segments = this.#lines[line];
    if (segments === undefined || segments.length === 0) return undefined;
    let low = 0;
    let high = segments.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (((segments[mid] as Int32Array)[0] as number) <= column) {
        found = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    // A function's position can sit just before its first mapped token.
    const segment = segments[found] ?? segments[0];
    if (segment === undefined || (segment[1] as number) < 0) return undefined;
    const source = this.map.sources[segment[1] as number];
    if (source === null || source === undefined) return undefined;
    const nameIndex = segment[4] as number;
    return {
      source: (this.map.sourceRoot ?? "") + source,
      line: segment[2] as number,
      column: segment[3] as number,
      name: nameIndex >= 0 ? this.map.names?.[nameIndex] : undefined,
    };
  }

  /** The original text of line `line` (0-based) of `source`, when the map embeds it. */
  sourceLine(source: string, line: number): string | undefined {
    const root = this.map.sourceRoot ?? "";
    const index = this.map.sources.findIndex((entry) => entry !== null && root + entry === source);
    return this.map.sourcesContent?.[index]?.split(/\r?\n/)[line];
  }
}

const KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "return",
  "catch",
  "function",
  "new",
  "await",
  "typeof",
]);

const MODIFIERS = /^(?:(?:static|async|get|set|public|private|protected|override|readonly)\s+)*$/;

/**
 * The name of the function that starts at or near `column` of `text`, its original source line
 * (minified bundles lose the names). It reads a declaration (`function name`), an assignment or
 * property (`name = (...) =>`, `name: function`, `const name = useCallback(() =>`), a method
 * (`name(...) {` at the start of the line), or a callback passed to a call (`useEffect callback`).
 * Undefined when nothing names it.
 */
export function functionNameAt(text: string, column: number): string | undefined {
  const after = text.slice(column);
  const before = text.slice(0, column);
  const declared =
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/.exec(after) ??
    (/\bfunction\s*\*?\s*$/.test(before) ? /^([\w$]+)/.exec(after) : null);
  if (declared?.[1] !== undefined) return declared[1];
  const assigned =
    /(#?[\w$]+)\s*(?::\s*[^=;(){}]*?)?\s*=\s*(?:await\s+)?(?:[\w$.]+(?:<[^>]*>)?\(\s*)?(?:async\s*)?(?:function\s*\*?\s*[\w$]*\s*)?$/.exec(
      before,
    ) ?? /(#?[\w$]+)\s*:\s*(?:async\s*)?(?:function\s*\*?\s*[\w$]*\s*)?$/.exec(before);
  if (assigned?.[1] !== undefined && !KEYWORDS.has(assigned[1])) return assigned[1];
  const calledWith = /([\w$.]+)\(\s*(?:[^()]*,\s*)?$/.exec(before);
  if (calledWith?.[1] !== undefined && !KEYWORDS.has(calledWith[1]))
    return `${calledWith[1]} callback`;
  const callsWith =
    /^([\w$.]+)\(\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::\s*[^=]+)?=>/.exec(after) ??
    /^([\w$.]+)\(\s*(?:async\s+)?function\b/.exec(after);
  if (callsWith?.[1] !== undefined && !KEYWORDS.has(callsWith[1]))
    return `${callsWith[1]} callback`;
  const method =
    /^(?:(?:static|async|get|set|public|private|protected|override)\s+)*\*?\s*(#?[\w$]+)\s*(?:<[^>]*>)?\s*\(/.exec(
      after,
    );
  if (
    method?.[1] !== undefined &&
    MODIFIERS.test(before.trim() === "" ? "" : `${before.trim()} `)
  ) {
    if (!KEYWORDS.has(method[1])) return method[1];
  }
  return undefined;
}

/** A repository-relative path, with forward slashes. */
function normalize(path: string): string {
  return posix
    .normalize(path.replaceAll("\\", "/"))
    .replace(/^(\.\.\/)+/, "")
    .replace(/^\.\//, "");
}

/**
 * Turns a mapped source into a repository-relative path. `scriptPath` is the script's URL path,
 * which maps to `apps/web/dist/` for a built app and to `apps/web/` for the dev server, except
 * the dev server's `/@fs/<absolute path>` modules.
 */
export function repoPath(source: string, scriptPath: string, repoRoot: string): string {
  const root = repoRoot.replaceAll("\\", "/").replace(/\/$/, "");
  const fromRoot = (absolute: string) =>
    absolute.toLowerCase().startsWith(`${root.toLowerCase()}/`)
      ? normalize(absolute.slice(root.length + 1))
      : posix.normalize(absolute);
  const path = source
    .replace(/^file:\/\/\/?/, "")
    .replaceAll("\\", "/")
    .replace(/^\/@fs\//, "");
  if (/^[A-Za-z]:\//.test(path)) return fromRoot(path);
  const script = decodeURIComponent(scriptPath.split("?")[0] ?? "");
  if (script.startsWith("/@fs/")) {
    return fromRoot(posix.join(posix.dirname(script.slice("/@fs/".length)), path));
  }
  const appRoot = script.startsWith("/assets/") ? "apps/web/dist" : "apps/web";
  return normalize(
    posix.join(path.startsWith("/") ? appRoot : posix.join(appRoot, posix.dirname(script)), path),
  );
}

function originOf(path: string): ResolvedFrame["origin"] {
  if (/(^|\/)node_modules\//.test(path) || path.startsWith("vite/") || path.includes("/@vite/")) {
    return "lib";
  }
  if (/^(apps|packages|crates|tests)\//.test(path)) return "app";
  return "lib";
}

/** Fetches a script's text, or undefined when it cannot. */
export type TextFetcher = (url: string) => Promise<string | undefined>;

export function sourceMappingUrl(script: string): string | undefined {
  const matches = [...script.matchAll(/\/\/[#@]\s*sourceMappingURL=(\S+)/g)];
  return matches.at(-1)?.[1];
}

/**
 * Loads the source maps of the profiled scripts and resolves call frames through them: name,
 * repository path and line of the original function, and whether it is ours. Frames without a map
 * fall back to `plainResolver`.
 */
export class SourceMapResolver {
  readonly #maps = new Map<string, SourceMap | undefined>();
  readonly #cache = new Map<string, ResolvedFrame>();
  readonly fetchText: TextFetcher;
  readonly repoRoot: string;

  constructor(fetchText: TextFetcher, repoRoot: string) {
    this.fetchText = fetchText;
    this.repoRoot = repoRoot;
  }

  /** How many of the scripts had a source map. */
  get mapped(): number {
    return [...this.#maps.values()].filter((map) => map !== undefined).length;
  }

  get scripts(): number {
    return this.#maps.size;
  }

  async load(urls: Iterable<string>): Promise<void> {
    const pending = [...new Set(urls)].filter(
      (url) => /^https?:/.test(url) && !/\.wasm(?:\?|$)/.test(url) && !this.#maps.has(url),
    );
    await Promise.all(
      pending.map(async (url) => {
        this.#maps.set(url, await this.#loadOne(url).catch(() => undefined));
      }),
    );
  }

  async #loadOne(url: string): Promise<SourceMap | undefined> {
    const script = await this.fetchText(url);
    const reference = script === undefined ? undefined : sourceMappingUrl(script);
    let text: string | undefined;
    if (reference?.startsWith("data:")) {
      const comma = reference.indexOf(",");
      const payload = reference.slice(comma + 1);
      text = reference.slice(0, comma).endsWith(";base64")
        ? Buffer.from(payload, "base64").toString("utf8")
        : decodeURIComponent(payload);
    } else {
      text = await this.fetchText(new URL(reference ?? `${url.split("?")[0]}.map`, url).href);
    }
    if (text === undefined) return undefined;
    const json = JSON.parse(text) as SourceMapJson;
    return typeof json.mappings === "string" ? new SourceMap(json) : undefined;
  }

  readonly resolve: FrameResolver = (frame: CallFrame) => {
    const key = `${frame.url}:${frame.lineNumber}:${frame.columnNumber}:${frame.functionName}`;
    let resolved = this.#cache.get(key);
    if (resolved === undefined) {
      resolved = this.#resolve(frame);
      this.#cache.set(key, resolved);
    }
    return resolved;
  };

  #resolve(frame: CallFrame): ResolvedFrame {
    const plain = plainResolver(frame);
    const map = frame.url === undefined ? undefined : this.#maps.get(frame.url);
    if (map === undefined || frame.url === undefined || frame.lineNumber === undefined)
      return plain;
    if (frame.lineNumber < 0) return plain;
    const position = map.lookup(frame.lineNumber, frame.columnNumber ?? 0);
    if (position === undefined) return plain;
    const scriptPath = new URL(frame.url).pathname;
    const path = repoPath(position.source, scriptPath, this.repoRoot);
    const text = map.sourceLine(position.source, position.line);
    // Built bundles are minified, so their names come from the source. Dev modules keep theirs.
    const minified = scriptPath.startsWith("/assets/");
    const name =
      (!minified && plain.name !== "(anonymous)" ? plain.name : undefined) ??
      (text === undefined ? undefined : functionNameAt(text, position.column)) ??
      position.name ??
      plain.name;
    return { name, location: `${shortPath(path)}:${position.line + 1}`, origin: originOf(path) };
  }
}
