import { FileTypeRegistry } from "@openpaint/extension-api";
import { avifFileType } from "./avif-file-type";
import { bmpFileType } from "./bmp-file-type";
import { ddsFileType } from "./dds-file-type";
import { gifFileType } from "./gif-file-type";
import { jpegFileType } from "./jpeg-file-type";
import { jxlFileType } from "./jxl-file-type";
import { opaintFileType } from "./opaint-file-type";
import { pngFileType } from "./png-file-type";
import { tgaFileType } from "./tga-file-type";
import { tiffFileType } from "./tiff-file-type";
import { webpFileType } from "./webp-file-type";

/** Settings the built-in file types read at save time. */
export interface BuiltinFileTypeOptions {
  /** The hidden "Embed color profiles in BMP" setting, read at each save (default off). */
  readonly embedBmpColorProfiles?: () => boolean;
  /** The bytes a `.opaint` load may allocate for its layers (WEB-MEM-03), read at each load. */
  readonly memoryBudgetBytes?: () => number;
}

/**
 * The registry of built-in file types, in the FMT-REG-01 order. Each codec registers here as it
 * lands, so pickers, extension lookup and the Save As list all come from this one list.
 */
export function builtinFileTypeRegistry(options: BuiltinFileTypeOptions = {}): FileTypeRegistry {
  const registry = new FileTypeRegistry();
  registry.register(pngFileType());
  registry.register(jpegFileType());
  registry.register(jxlFileType());
  registry.register(avifFileType());
  registry.register(webpFileType());
  registry.register(ddsFileType());
  registry.register(tiffFileType());
  registry.register(gifFileType());
  registry.register(bmpFileType(options.embedBmpColorProfiles));
  registry.register(tgaFileType());
  registry.register(opaintFileType(options.memoryBudgetBytes));
  return registry;
}
