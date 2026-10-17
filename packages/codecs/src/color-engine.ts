import {
  cmsFLAGS_BLACKPOINTCOMPENSATION,
  cmsSigCmykData,
  cmsSigGrayData,
  cmsSigRgbData,
  INTENT_RELATIVE_COLORIMETRIC,
  instantiate,
  type LcmsModule,
  TYPE_CMYK_8,
  TYPE_CMYK_16,
  TYPE_GRAY_8,
  TYPE_GRAY_16,
  TYPE_RGB_8,
  TYPE_RGB_16,
} from "lcms-wasm";

/**
 * The color engine (WEB-COL-01): LittleCMS compiled to WASM. It opens an ICC profile and converts
 * samples in the profile's space to 8-bit sRGB, with the relative colorimetric intent and black-point
 * compensation (DOC-DOC-05, FMT-META-03). Only RGB, gray and CMYK profiles are converted.
 */

/** The profile spaces the engine converts from. */
export type ProfileSpace = "gray" | "rgb" | "cmyk";

/** Interleaved samples in one profile space. `bitsPerSample` 16 means little-endian 16-bit samples. */
export interface ColorSamples {
  readonly space: ProfileSpace;
  readonly bitsPerSample: 8 | 16;
  readonly samples: Uint8Array;
}

/** A profile that cannot be opened, is not an RGB, gray or CMYK profile, or cannot make a transform. */
export class ProfileError extends Error {
  override readonly name = "ProfileError";
}

const CHANNELS: Record<ProfileSpace, number> = { gray: 1, rgb: 3, cmyk: 4 };
const FORMATS: Record<ProfileSpace, Record<8 | 16, number>> = {
  gray: { 8: TYPE_GRAY_8, 16: TYPE_GRAY_16 },
  rgb: { 8: TYPE_RGB_8, 16: TYPE_RGB_16 },
  cmyk: { 8: TYPE_CMYK_8, 16: TYPE_CMYK_16 },
};
const SRGB_BYTES_PER_PIXEL = 3;
/** Pixels per transform call, so a large image never needs one huge buffer in the WASM heap. */
const CHUNK_PIXELS = 1 << 16;

let engine: Promise<LcmsModule> | undefined;

function loadEngine(): Promise<LcmsModule> {
  engine ??= instantiate();
  return engine;
}

/** The space of an ICC profile, or undefined when it is not an RGB, gray or CMYK profile. */
export async function profileSpace(profile: Uint8Array): Promise<ProfileSpace | undefined> {
  const lcms = await loadEngine();
  return withOpenProfile(lcms, profile, (handle) => spaceOf(lcms._cmsGetColorSpace(handle)));
}

/**
 * Converts samples from an ICC profile into 8-bit sRGB, three bytes per pixel. The profile's space
 * must match `input.space`, or the profile is refused with a `ProfileError`.
 */
export async function convertToSrgb(profile: Uint8Array, input: ColorSamples): Promise<Uint8Array> {
  const lcms = await loadEngine();
  const pixels = withOpenProfile(lcms, profile, (handle) => {
    if (spaceOf(lcms._cmsGetColorSpace(handle)) !== input.space) {
      throw new ProfileError("The profile does not describe the samples' color space.");
    }
    return transformToSrgb(lcms, handle, input);
  });
  if (pixels === undefined) throw new ProfileError("The profile could not be opened.");
  return pixels;
}

function spaceOf(signature: number): ProfileSpace | undefined {
  if (signature === cmsSigRgbData) return "rgb";
  if (signature === cmsSigGrayData) return "gray";
  if (signature === cmsSigCmykData) return "cmyk";
  return undefined;
}

/**
 * Runs `use` with the profile open. The profile bytes stay in the WASM heap until the profile is
 * closed, because LittleCMS reads the tags lazily. Returns undefined when the profile does not open.
 */
function withOpenProfile<T>(
  lcms: LcmsModule,
  profile: Uint8Array,
  use: (handle: number) => T,
): T | undefined {
  const bytes = lcms._malloc(profile.length);
  try {
    lcms.HEAPU8.set(profile, bytes);
    const handle = lcms._cmsOpenProfileFromMem(bytes, profile.length);
    if (handle === 0) return undefined;
    try {
      return use(handle);
    } finally {
      lcms._cmsCloseProfile(handle);
    }
  } finally {
    lcms._free(bytes);
  }
}

function transformToSrgb(lcms: LcmsModule, source: number, input: ColorSamples): Uint8Array {
  const target = lcms._cmsCreate_sRGBProfile();
  if (target === 0) throw new ProfileError("The sRGB profile could not be created.");
  try {
    const transform = lcms._cmsCreateTransform(
      source,
      FORMATS[input.space][input.bitsPerSample],
      target,
      TYPE_RGB_8,
      INTENT_RELATIVE_COLORIMETRIC,
      cmsFLAGS_BLACKPOINTCOMPENSATION,
    );
    if (transform === 0) throw new ProfileError("The profile cannot be used for conversion.");
    try {
      return runTransform(lcms, transform, input);
    } finally {
      lcms._cmsDeleteTransform(transform);
    }
  } finally {
    lcms._cmsCloseProfile(target);
  }
}

function runTransform(lcms: LcmsModule, transform: number, input: ColorSamples): Uint8Array {
  const bytesPerSample = input.bitsPerSample / 8;
  const pixelBytes = CHANNELS[input.space] * bytesPerSample;
  const pixelCount = input.samples.byteLength / pixelBytes;
  const out = new Uint8Array(pixelCount * SRGB_BYTES_PER_PIXEL);
  for (let first = 0; first < pixelCount; first += CHUNK_PIXELS) {
    const count = Math.min(CHUNK_PIXELS, pixelCount - first);
    const inputLength = count * pixelBytes;
    const inputPointer = lcms._malloc(inputLength);
    const outputPointer = lcms._malloc(count * SRGB_BYTES_PER_PIXEL);
    try {
      const chunk = input.samples.subarray(first * pixelBytes, first * pixelBytes + inputLength);
      lcms.HEAPU8.set(chunk, inputPointer);
      lcms._cmsDoTransform(transform, inputPointer, outputPointer, count);
      out.set(
        lcms.HEAPU8.subarray(outputPointer, outputPointer + count * SRGB_BYTES_PER_PIXEL),
        first * SRGB_BYTES_PER_PIXEL,
      );
    } finally {
      lcms._free(inputPointer);
      lcms._free(outputPointer);
    }
  }
  return out;
}
