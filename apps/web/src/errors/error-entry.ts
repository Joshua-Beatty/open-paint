import type { Translate } from "@openpaint/i18n";

/** The message and stack of an error, as they are logged. */
export interface ErrorDetails {
  readonly message: string;
  readonly stack: string | undefined;
}

/** The line that closes each log entry (SET-ERR-01). */
export const LOG_ENTRY_SEPARATOR = "-".repeat(60);

/** Reads the message and stack of anything that was thrown or rejected. */
export function describeError(cause: unknown): ErrorDetails {
  if (cause instanceof Error) {
    const message = cause.message === "" ? cause.name : `${cause.name}: ${cause.message}`;
    return { message, stack: cause.stack };
  }
  return { message: describeValue(cause), stack: undefined };
}

function describeValue(value: unknown): string {
  if (typeof value === "string") return value === "" ? "Unknown error" : value;
  try {
    const text = JSON.stringify(value);
    if (text !== undefined) return text;
  } catch {
    // Circular or otherwise unserializable values fall through to String().
  }
  return String(value);
}

/** The text an error dialog shows under "Show details": the stack, or the message without one. */
export function errorDetailsText(details: ErrorDetails): string {
  return details.stack ?? details.message;
}

export interface LogEntryInput {
  readonly time: Date;
  readonly version: string;
  readonly details: ErrorDetails;
  /** Where the error was caught, when the caller knows it. */
  readonly context?: string | undefined;
  /** The SET-ERR-05 report, already formatted. */
  readonly diagnostics: string;
  readonly translate: Translate;
}

/**
 * Formats one log entry (SET-ERR-01): the header, the UTC time, the version, the error message and
 * stack, the diagnostics block, and a separator line. `title` is the message, for the list.
 */
export function formatLogEntry(input: LogEntryInput): { title: string; text: string } {
  const { time, version, details, context, diagnostics, translate: t } = input;
  const lines = [
    t("error.log.header"),
    "",
    `${t("error.log.time")}: ${time.toISOString()}`,
    `${t("error.log.version")}: ${version}`,
    ...(context === undefined ? [] : [`${t("error.log.context")}: ${context}`]),
    `${t("error.log.message")}: ${details.message}`,
    ...(details.stack === undefined ? [] : [`${t("error.log.stack")}:`, details.stack]),
    "",
    t("error.log.diagnostics"),
    diagnostics,
    "",
    LOG_ENTRY_SEPARATOR,
  ];
  return { title: details.message.split("\n")[0] ?? details.message, text: lines.join("\n") };
}
