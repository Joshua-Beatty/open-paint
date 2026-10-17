# Changelog

Changes to the internal extension API (`@openpaint/extension-api`). The API version is semantic:
breaking changes bump the major version, and each descriptor declares the major version it targets
(`apiVersion`, EXT-02-13).

## 1.0.0 (M1.02)

- Registries for effects and adjustments (`EffectRegistry`), file types (`FileTypeRegistry`, with
  `registerFactory` for EXT-07-05), tools (`ToolRegistry`) and shapes (`ShapeRegistry`). Each keeps
  registration order and rejects duplicate or empty ids and unsupported API versions.
- Descriptors: `EffectDescriptor` (label, icon, category, submenu, configurable flag, property
  schema, effect kind, render options, optional renderer factory), `FileTypeDescriptor` (name,
  extensions, MIME types, capability flags, save-options schema, lazy codec with `load` and `save`,
  `isLossless`), `ToolDescriptor` (hotkey, skip-if-active, commit capability, options schema) and
  `ShapeDescriptor` (category, SVG path geometry, settings, handles).
- Render contracts for the five effect kinds (CPU region and tile, GPU image, GPU drawing and
  low-level GPU), with the token-change and cancellation rules of EXT-03.
- Environment (`EffectEnvironment`, `SimpleEffectEnvironment`) and the document model seen by file
  types (`FileDocument`, `BitmapLayer`, `DocumentMetadata`).
- Asynchronous host services (`HostServices`, EXT-05), including quantization and resampling for
  file types.
- Discovery helpers that build menu and file-type lists from the registries: `effectMenu`,
  `openFileTypes`, `saveFileTypes`, `openAcceptExtensions`, `findOpenFileType`, `findSaveFileType`
  and `shapeCategories`.
- `EffectDescriptor.customDialog` names a bespoke editor the UI registers (EXT-V1-02). The text
  layout service in `ImagingService` is a contract only until the engine implements it.
- Gaussian Blur migrated to the descriptor shape (`kind: "gpuImage"`, `options.gpu.workingSpace`).
  Its renderer stays bound by id in the engine.
