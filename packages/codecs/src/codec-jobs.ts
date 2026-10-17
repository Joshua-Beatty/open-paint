import decodeAvifImage from "@jsquash/avif/decode.js";
import initWasm, {
  decode_dds,
  decode_jxl,
  decode_webp,
  encode_avif,
  magic_wand_mask,
  read_avif_metadata,
  wrap_jxl,
  wrap_webp,
} from "@openpaint/cpu";
import { encodeJxlCodestream } from "./jxl-encoder";
import { encodeWebpBitstream } from "./webp-encoder";
import type { WebpPreset } from "./webp-options";

/**
 * The WebP encoder's inputs. `quality` is 0 to 100 and `preset` apply to lossy output only, so both are
 * ignored when `lossless` is set. The libwebp bitstream is wrapped with the metadata chunks.
 */
export interface WebpEncodeArgs {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
  readonly lossless: boolean;
  readonly quality: number;
  readonly preset: WebpPreset;
  readonly icc: Uint8Array;
  readonly exif: Uint8Array;
  readonly xmp: Uint8Array;
}

/** A WebP file opened to straight RGBA, with the metadata chunks it carried. */
export interface WebpDecoded {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly icc: Uint8Array;
  readonly exif: Uint8Array;
  readonly xmp: Uint8Array;
}

/** The AVIF encoder's inputs (FMT-OPT-AVIF-01), with the chroma choice as its id (0, 1 or 2). */
export interface AvifEncodeArgs {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
  readonly lossless: boolean;
  readonly quality: number;
  readonly losslessAlpha: boolean;
  readonly alphaQuality: number;
  readonly speed: number;
  readonly chroma: number;
  readonly premultiplied: boolean;
  readonly exif: Uint8Array;
  readonly xmp: Uint8Array;
  readonly icc: Uint8Array;
}

/**
 * An AVIF file opened to straight RGBA (libavif, WEB-FILE-07), with the ICC profile and the metadata items it
 * carried. Empty for what the file does not have.
 */
export interface AvifDecoded {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly icc: Uint8Array;
  readonly exif: Uint8Array;
  readonly xmp: Uint8Array;
}

/**
 * The JPEG XL encoder's inputs (FMT-OPT-JXL-01): libjxl encodes the codestream, then the metadata boxes
 * (empty for none) are wrapped around it.
 */
export interface JxlEncodeArgs {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
  readonly lossless: boolean;
  readonly quality: number;
  readonly effort: number;
  readonly exif: Uint8Array;
  readonly xmp: Uint8Array;
}

/** A JPEG XL file opened to straight RGBA, with the ICC profile and metadata boxes it carried. */
export interface JxlDecoded {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly icc: Uint8Array;
  readonly exif: Uint8Array;
  readonly xmp: Uint8Array;
}

/** A DDS texture opened to straight RGBA (its top mip level). */
export interface DdsDecoded {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/** The flag bits of `magic_wand_mask` (crates/opaint-cpu/src/magic_wand.rs). */
const MAGIC_WAND_STRAIGHT = 1;
const MAGIC_WAND_GLOBAL = 2;

/** The arguments of each codec job, by operation. */
export interface CodecJobArgs {
  readonly encodeWebp: WebpEncodeArgs;
  readonly decodeWebp: { readonly bytes: Uint8Array };
  readonly encodeAvif: AvifEncodeArgs;
  readonly decodeAvif: { readonly bytes: Uint8Array };
  readonly encodeJxl: JxlEncodeArgs;
  readonly decodeJxl: { readonly bytes: Uint8Array };
  readonly decodeDds: { readonly bytes: Uint8Array };
  readonly magicWandMask: MagicWandArgs;
}

/**
 * The Magic Wand flood (TL-SEL-WAND-01, TL-ALG-TOL): `pixels` is straight RGBA8 of `width` x `height`,
 * `tolerance` runs from 0 to 1, and `straight` and `global` pick the alpha mode and the flood mode.
 */
export interface MagicWandArgs {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly seedX: number;
  readonly seedY: number;
  readonly tolerance: number;
  readonly straight: boolean;
  readonly global: boolean;
}

/** The result of each codec job, by operation. */
export interface CodecJobResults {
  readonly encodeWebp: Uint8Array;
  readonly decodeWebp: WebpDecoded;
  readonly encodeAvif: Uint8Array;
  readonly decodeAvif: AvifDecoded;
  readonly encodeJxl: Uint8Array;
  readonly decodeJxl: JxlDecoded;
  readonly decodeDds: DdsDecoded;
  /** One byte per pixel: 255 where the wand selects, 0 elsewhere. */
  readonly magicWandMask: Uint8Array;
}

export type CodecJobOp = keyof CodecJobArgs;

/** One job as it crosses to the worker. */
export type CodecJob = {
  readonly [Op in CodecJobOp]: { readonly op: Op; readonly args: CodecJobArgs[Op] };
}[CodecJobOp];

let wasmReady: Promise<unknown> | undefined;

/**
 * Instantiates the codec WASM once in this realm, the first time a job needs it (WEB-FILE-07). The
 * main thread shares the module that the app already loaded, and the worker loads its own copy.
 */
export function ensureCodecWasm(): Promise<unknown> {
  wasmReady ??= initWasm();
  return wasmReady;
}

/** Runs one job against the WASM codecs. The caller has initialized them. */
export async function executeCodecJob(job: CodecJob): Promise<CodecJobResults[CodecJobOp]> {
  switch (job.op) {
    case "encodeWebp": {
      const a = job.args;
      const bitstream = await encodeWebpBitstream(a.width, a.height, a.rgba, {
        quality: a.quality,
        lossless: a.lossless,
        preset: a.preset,
      });
      return wrap_webp(bitstream, a.width, a.height, a.icc, a.exif, a.xmp);
    }
    case "decodeWebp": {
      const decoded = decode_webp(job.args.bytes);
      try {
        return {
          width: decoded.width,
          height: decoded.height,
          pixels: decoded.pixels,
          icc: decoded.icc,
          exif: decoded.exif,
          xmp: decoded.xmp,
        };
      } finally {
        decoded.free();
      }
    }
    case "encodeAvif": {
      const a = job.args;
      return encode_avif(
        a.width,
        a.height,
        a.rgba,
        a.lossless,
        a.quality,
        a.losslessAlpha,
        a.alphaQuality,
        a.speed,
        a.chroma,
        a.premultiplied,
        a.exif,
        a.xmp,
        a.icc,
      );
    }
    case "decodeAvif": {
      const image = await decodeAvifImage(job.args.bytes.slice().buffer);
      if (image === null) throw new Error("The AVIF decoder returned no image.");
      return {
        width: image.width,
        height: image.height,
        pixels: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
        ...readAvifMetadataOf(job.args.bytes),
      };
    }
    case "encodeJxl": {
      const a = job.args;
      const codestream = await encodeJxlCodestream(a.width, a.height, a.rgba, {
        quality: a.quality,
        effort: a.effort,
        lossless: a.lossless,
      });
      return wrap_jxl(codestream, a.exif, a.xmp);
    }
    case "decodeJxl": {
      const decoded = decode_jxl(job.args.bytes);
      try {
        return {
          width: decoded.width,
          height: decoded.height,
          pixels: decoded.pixels,
          icc: decoded.icc,
          exif: decoded.exif,
          xmp: decoded.xmp,
        };
      } finally {
        decoded.free();
      }
    }
    case "decodeDds": {
      const decoded = decode_dds(job.args.bytes);
      try {
        return { width: decoded.width, height: decoded.height, pixels: decoded.pixels };
      } finally {
        decoded.free();
      }
    }
    case "magicWandMask": {
      const a = job.args;
      const flags = (a.straight ? MAGIC_WAND_STRAIGHT : 0) | (a.global ? MAGIC_WAND_GLOBAL : 0);
      return magic_wand_mask(a.pixels, a.width, a.height, a.seedX, a.seedY, a.tolerance, flags);
    }
  }
}

const NO_BYTES = new Uint8Array(0);

/**
 * The metadata items and ICC profile of an AVIF file (FMT-META-01, FMT-META-03). A container whose items cannot
 * be read opens its pixels without them, so a read failure gives the empty values.
 */
function readAvifMetadataOf(bytes: Uint8Array): Omit<AvifDecoded, "width" | "height" | "pixels"> {
  const empty = { icc: NO_BYTES, exif: NO_BYTES, xmp: NO_BYTES };
  let metadata: ReturnType<typeof read_avif_metadata>;
  try {
    metadata = read_avif_metadata(bytes);
  } catch {
    return empty;
  }
  try {
    return { icc: metadata.icc, exif: metadata.exif, xmp: metadata.xmp };
  } finally {
    metadata.free();
  }
}

type WorkerReply =
  | { readonly id: number; readonly ok: true; readonly result: CodecJobResults[CodecJobOp] }
  | { readonly id: number; readonly ok: false; readonly message: string };

interface PendingJob {
  readonly resolve: (result: CodecJobResults[CodecJobOp]) => void;
  readonly reject: (error: Error) => void;
}

let codecWorker: Worker | undefined;
let nextJobId = 0;
const pendingJobs = new Map<number, PendingJob>();

function ownWorker(): Worker {
  if (codecWorker !== undefined) return codecWorker;
  const worker = new Worker(new URL("./codec-worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    const reply = event.data;
    const pending = pendingJobs.get(reply.id);
    if (pending === undefined) return;
    pendingJobs.delete(reply.id);
    if (reply.ok) pending.resolve(reply.result);
    else pending.reject(new Error(reply.message));
  };
  worker.onerror = (event: ErrorEvent) => {
    codecWorker = undefined;
    worker.terminate();
    const error = new Error(event.message || "The codec worker stopped.");
    for (const pending of pendingJobs.values()) pending.reject(error);
    pendingJobs.clear();
  };
  codecWorker = worker;
  return worker;
}

/**
 * Runs a codec job in the codec worker, which loads the WASM on its first job (WEB-FILE-07). Where
 * no worker exists (Node tests), the job runs in this realm instead.
 */
export async function runCodecJob<Op extends CodecJobOp>(
  op: Op,
  args: CodecJobArgs[Op],
): Promise<CodecJobResults[Op]> {
  const job = { op, args } as CodecJob;
  if (typeof Worker === "undefined") {
    await ensureCodecWasm();
    return (await executeCodecJob(job)) as CodecJobResults[Op];
  }
  const id = nextJobId;
  nextJobId += 1;
  const result = new Promise<CodecJobResults[CodecJobOp]>((resolve, reject) => {
    pendingJobs.set(id, { resolve, reject });
  });
  ownWorker().postMessage({ id, job });
  return result as Promise<CodecJobResults[Op]>;
}
