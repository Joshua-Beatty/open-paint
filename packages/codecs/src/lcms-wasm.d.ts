/**
 * Types for the parts of `lcms-wasm` (LittleCMS compiled to WASM, MIT) that the color engine uses.
 * The package ships JavaScript only. The names are the exports of its Emscripten module.
 */
declare module "lcms-wasm" {
  /** The Emscripten module. Its heap views are replaced when the memory grows, so read them afresh. */
  export interface LcmsModule {
    HEAPU8: Uint8Array;
    _malloc(size: number): number;
    _free(pointer: number): void;
    _cmsOpenProfileFromMem(pointer: number, size: number): number;
    _cmsCloseProfile(profile: number): number;
    _cmsGetColorSpace(profile: number): number;
    _cmsCreate_sRGBProfile(): number;
    _cmsCreateTransform(
      input: number,
      inputFormat: number,
      output: number,
      outputFormat: number,
      intent: number,
      flags: number,
    ): number;
    _cmsDeleteTransform(transform: number): void;
    _cmsDoTransform(transform: number, input: number, output: number, size: number): void;
  }

  export interface LcmsOptions {
    readonly locateFile?: (path: string, directory: string) => string;
  }

  export function instantiate(options?: LcmsOptions): Promise<LcmsModule>;

  export const INTENT_RELATIVE_COLORIMETRIC: number;
  export const cmsFLAGS_BLACKPOINTCOMPENSATION: number;
  export const cmsSigGrayData: number;
  export const cmsSigRgbData: number;
  export const cmsSigCmykData: number;
  export const TYPE_GRAY_8: number;
  export const TYPE_GRAY_16: number;
  export const TYPE_RGB_8: number;
  export const TYPE_RGB_16: number;
  export const TYPE_CMYK_8: number;
  export const TYPE_CMYK_16: number;
}
