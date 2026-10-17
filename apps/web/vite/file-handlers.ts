/**
 * The PWA `file_handlers` accept map (FMT-SHELL-02, WEB-FILE-05): each MIME type with the extensions
 * OpenPaint opens. `vite.config.ts` cannot load the codec registry, so the map is written out here,
 * and `file-handlers.test.ts` fails when it drifts from the built-in file types. ".ora" is [LATER].
 */
export const FILE_HANDLER_ACCEPT: Record<string, string[]> = {
  "image/x-openpaint": [".opaint"],
  "image/avif": [".avif"],
  "image/bmp": [".bmp", ".dib", ".rle"],
  "image/vnd.ms-dds": [".dds"],
  "image/gif": [".gif"],
  "image/jpeg": [".jfif", ".jpe", ".jpeg", ".jpg"],
  "image/jxl": [".jxl"],
  "image/png": [".png"],
  "image/x-tga": [".tga"],
  "image/tiff": [".tif", ".tiff"],
  "image/webp": [".webp"],
};
