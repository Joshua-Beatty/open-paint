import { DecodeError, OpaintFormatError } from "@openpaint/codecs";
import { OutOfMemoryError } from "@openpaint/document";
import type { MessageId, MessageValues, Translate } from "@openpaint/i18n";

/** The extension matches no registered file type (FMT-OPEN-02). */
export class UnrecognizedFileError extends Error {
  override readonly name = "UnrecognizedFileError";
}

/** A file type whose codec could not be loaded (FMT-REG-01). `cause` is the codec's error. */
export class CodecUnavailableError extends Error {
  override readonly name = "CodecUnavailableError";

  constructor(cause: unknown) {
    super("A codec could not be loaded.", { cause });
  }
}

/** A message to show: a catalog key and the values it takes. */
export interface FileMessage {
  readonly id: MessageId;
  readonly values?: MessageValues;
}

/** Maps a failed open to its FMT-OPEN-04 message. */
export function openFailure(error: unknown): FileMessage {
  if (error instanceof UnrecognizedFileError) return { id: "file.error.unrecognized" };
  if (error instanceof CodecUnavailableError) return codecFailure(error);
  if (error instanceof OutOfMemoryError) return { id: "file.error.memory" };
  if (error instanceof DecodeError) return { id: "file.error.decode" };
  if (error instanceof OpaintFormatError) return opaintFailure(error);
  switch (errorName(error)) {
    case "NotFoundError":
      return { id: "file.error.notFound" };
    case "NotAllowedError":
    case "SecurityError":
      return { id: "file.error.access" };
    case "NotReadableError":
      return { id: "file.error.read" };
    default:
      return { id: "file.error.unknown" };
  }
}

/**
 * Maps a failed save to its FMT-SAVE-05 message. `phase` says whether the encoder or the file
 * write failed, since only a write error is an I/O error.
 */
export function saveFailure(error: unknown, phase: "encode" | "write"): FileMessage {
  if (error instanceof CodecUnavailableError) return codecFailure(error);
  if (error instanceof OutOfMemoryError) return { id: "file.saveError.memory" };
  if (phase === "encode") return { id: "file.saveError.other" };
  switch (errorName(error)) {
    case "NotAllowedError":
    case "SecurityError":
      return { id: "file.saveError.access" };
    case "NotFoundError":
      return { id: "file.saveError.notFound" };
    case "QuotaExceededError":
      return { id: "file.saveError.quota" };
    default:
      return { id: "file.saveError.io" };
  }
}

export function failureText(message: FileMessage, t: Translate): string {
  return t(message.id, message.values);
}

/** FMT-NAT-08 and FMT-NAT-09: a newer file needs a newer reader; the others are corrupt or unknown. */
function opaintFailure(error: OpaintFormatError): FileMessage {
  switch (error.reason) {
    case "newerReader":
      return { id: "file.error.newerVersion" };
    case "unrecognized":
      return { id: "file.error.unrecognized" };
    case "corrupt":
      return { id: "file.error.corrupt" };
  }
}

function codecFailure(error: CodecUnavailableError): FileMessage {
  const cause = error.cause;
  return {
    id: "file.error.codec",
    values: { error: cause instanceof Error ? cause.message : String(cause) },
  };
}

/** The DOM or Error name of a thrown value, such as "NotFoundError". */
export function errorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "name" in error
    ? String(error.name)
    : undefined;
}
