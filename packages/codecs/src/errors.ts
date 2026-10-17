/** A decoder rejected the bytes as an image it cannot read (FMT-OPEN-04, "unexpected decoder input"). */
export class DecodeError extends Error {
  override readonly name = "DecodeError";

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
  }
}
