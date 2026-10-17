import { DEFAULT_MEMORY_BUDGET_BYTES } from "@openpaint/document";
import {
  type ByteSource,
  EXTENSION_API_MAJOR,
  type FileCodec,
  type FileTypeDescriptor,
} from "@openpaint/extension-api";
import { definePropertySchema } from "@openpaint/properties";
import { OPAINT_MIME, readOpaint, writeOpaint } from "./opaint-file";
import { isOpaintBytes } from "./sniff";

/**
 * The native `.opaint` file type (FMT-NAT-01). It keeps layers, selection, metadata and unknown
 * entries, so it is the one layered format. It has no save options. The memory budget is read at each
 * load, so the layers are checked before their pixels are decoded (FMT-NAT-10).
 */
export function opaintFileType(
  memoryBudgetBytes: () => number = () => DEFAULT_MEMORY_BUDGET_BYTES,
): FileTypeDescriptor {
  const codec: FileCodec = {
    async load(source: ByteSource) {
      return readOpaint(await source.readAll(), { memoryBudgetBytes: memoryBudgetBytes() });
    },
    async save(file, sink, _token, progress) {
      progress(0);
      const bytes = await writeOpaint(file, progress);
      await sink.write(bytes);
      progress(1);
    },
  };
  return {
    id: "opaint",
    apiVersion: EXTENSION_API_MAJOR,
    label: "fileType.opaint",
    icon: "file-opaint",
    loadExtensions: [".opaint"],
    saveExtensions: [".opaint"],
    mimeTypes: [OPAINT_MIME],
    capabilities: {
      supportsLayers: true,
      supportsCustomHeaders: false,
      supportsSaving: true,
      supportsLoading: true,
      savesWithProgress: true,
      supportsCancellation: true,
    },
    saveOptions: definePropertySchema({ properties: [] }),
    sniff: isOpaintBytes,
    loadCodec: async () => codec,
    isLossless: () => true,
  };
}
