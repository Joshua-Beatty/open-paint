/** The platform decides what "Ctrl" means and how labels are written (WEB-KEY-01, WEB-KEY-06). */
export type ShortcutPlatform = "mac" | "other";

/**
 * One key with its modifiers. `code` is the layout-independent key code (for example `KeyN` or
 * `BracketLeft`), so a binding names the same physical key on every keyboard layout.
 */
export interface KeyChord {
  readonly code: string;
  /** Ctrl on Windows and Linux, Command on macOS (WEB-KEY-01). */
  readonly primary: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

/** The fields of a keyboard event that shortcut matching reads. */
export interface KeyEventLike {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

const PUNCTUATION_CODES: Readonly<Record<string, string>> = {
  "[": "BracketLeft",
  "]": "BracketRight",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "-": "Minus",
  "=": "Equal",
  "`": "Backquote",
};

const NAMED_CODES = new Set([
  "Tab",
  "Delete",
  "Backspace",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "NumpadAdd",
  "NumpadSubtract",
]);

const KEY_LABELS: Readonly<Record<string, string>> = {
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  NumpadAdd: "+",
  NumpadSubtract: "-",
};

const MODIFIERS = new Set(["Ctrl", "Shift", "Alt"]);

function keyCode(token: string): string {
  const punctuation = PUNCTUATION_CODES[token];
  if (punctuation !== undefined) return punctuation;
  if (/^[A-Z]$/.test(token)) return `Key${token}`;
  if (/^[0-9]$/.test(token)) return `Digit${token}`;
  if (NAMED_CODES.has(token) || /^Numpad[0-9]$/.test(token) || /^F([1-9]|1[0-2])$/.test(token)) {
    return token;
  }
  throw new Error(`Unknown shortcut key "${token}".`);
}

function keyLabel(code: string): string {
  const named = KEY_LABELS[code];
  if (named !== undefined) return named;
  const letter = /^Key([A-Z])$/.exec(code) ?? /^Digit([0-9])$/.exec(code);
  return letter?.[1] ?? code;
}

/**
 * Parses a binding written in the spec's notation, such as `Ctrl+Shift+N`, `Alt+[` or
 * `Shift+Delete`. "Ctrl" is the platform's primary modifier. The last part is the key.
 */
export function parseChord(text: string): KeyChord {
  const parts = text.split("+");
  const key = parts.pop() ?? "";
  const seen = new Set<string>();
  for (const modifier of parts) {
    if (!MODIFIERS.has(modifier) || seen.has(modifier)) {
      throw new Error(`Invalid shortcut modifier "${modifier}" in "${text}".`);
    }
    seen.add(modifier);
  }
  return {
    code: keyCode(key),
    primary: seen.has("Ctrl"),
    shift: seen.has("Shift"),
    alt: seen.has("Alt"),
  };
}

/**
 * The label shown to the user (WEB-KEY-06). macOS uses Apple's symbols in its usual order,
 * for example "⌘S" or "⌥⇧⌘C". Other platforms spell the modifiers out in the order Ctrl, Alt,
 * Shift, for example "Ctrl+Alt+S" or "Alt+Shift+H", as the spec writes them.
 */
export function formatChord(chord: KeyChord, platform: ShortcutPlatform): string {
  const key = keyLabel(chord.code);
  if (platform === "mac") {
    return `${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${chord.primary ? "⌘" : ""}${key}`;
  }
  const parts: string[] = [];
  if (chord.primary) parts.push("Ctrl");
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/**
 * Whether a key event is exactly this chord. Every modifier must match, so Ctrl+Shift+N does not
 * fire Ctrl+N. The other primary key (Command on Windows, Ctrl on macOS) must be up.
 */
export function chordMatches(
  chord: KeyChord,
  event: KeyEventLike,
  platform: ShortcutPlatform,
): boolean {
  if (event.code !== chord.code) return false;
  const primaryDown = platform === "mac" ? event.metaKey : event.ctrlKey;
  const otherPrimaryDown = platform === "mac" ? event.ctrlKey : event.metaKey;
  return (
    primaryDown === chord.primary &&
    !otherPrimaryDown &&
    event.shiftKey === chord.shift &&
    event.altKey === chord.alt
  );
}

/** A string that is equal for two chords exactly when they match the same events. */
export function chordKey(chord: KeyChord): string {
  return `${chord.primary ? 1 : 0}${chord.shift ? 1 : 0}${chord.alt ? 1 : 0}${chord.code}`;
}

/** Reads the platform from `navigator.platform`, or the user agent when that is empty. */
export function platformFromName(name: string): ShortcutPlatform {
  return /Mac|iPhone|iPad|iPod/.test(name) ? "mac" : "other";
}
