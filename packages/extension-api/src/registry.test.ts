import { definePropertySchema } from "@openpaint/properties";
import { describe, expect, it } from "vitest";
import type { EffectDescriptor } from "./effects";
import type { FileTypeDescriptor, FileTypeHost } from "./file-types";
import { EffectRegistry, FileTypeRegistry, ShapeRegistry, ToolRegistry } from "./registry";
import type { ShapeDescriptor } from "./shapes";
import type { ToolDescriptor } from "./tools";

const blur: EffectDescriptor = {
  id: "gaussian-blur",
  apiVersion: 1,
  label: "effect.gaussianBlur",
  icon: "icon.gaussianBlur",
  category: "effect",
  submenu: "blurs",
  configurable: true,
  kind: "gpuImage",
  schema: definePropertySchema({ properties: [] }),
};

const png: FileTypeDescriptor = {
  id: "png",
  apiVersion: 1,
  label: "app.name",
  icon: "icon.png",
  loadExtensions: [".png"],
  saveExtensions: [".png"],
  mimeTypes: ["image/png"],
  capabilities: {
    supportsLayers: false,
    supportsCustomHeaders: false,
    supportsSaving: true,
    supportsLoading: true,
    savesWithProgress: false,
    supportsCancellation: false,
  },
  saveOptions: definePropertySchema({ properties: [] }),
  loadCodec: () => Promise.reject(new Error("not used in these tests")),
  isLossless: () => true,
};

const tool: ToolDescriptor = {
  id: "paintbrush",
  apiVersion: 1,
  label: "app.name",
  help: "app.name",
  icon: "icon.paintbrush",
  hotkey: "B",
  skipIfActive: true,
  commitCapable: false,
  options: definePropertySchema({ properties: [] }),
};

const rectangle: ShapeDescriptor = {
  id: "rectangle",
  apiVersion: 1,
  label: "app.name",
  category: "basic",
  geometry: { path: "M 0,0 L 1,0 L 1,1 L 0,1 Z", fillRule: "nonzero" },
  settings: definePropertySchema({ properties: [] }),
};

describe("EffectRegistry", () => {
  it("lists registered effects in registration order and looks them up by id", () => {
    const registry = new EffectRegistry();
    const other: EffectDescriptor = { ...blur, id: "other" };
    registry.register(blur);
    registry.register(other);
    expect(registry.list().map((effect) => effect.id)).toEqual(["gaussian-blur", "other"]);
    expect(registry.get("gaussian-blur")).toBe(blur);
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.has("other")).toBe(true);
  });

  it("rejects duplicate ids", () => {
    const registry = new EffectRegistry();
    registry.register(blur);
    expect(() => registry.register(blur)).toThrow('Effect "gaussian-blur" is already registered.');
  });

  it("rejects an empty id", () => {
    const registry = new EffectRegistry();
    expect(() => registry.register({ ...blur, id: "" })).toThrow("Effect id must not be empty.");
  });

  it("rejects an API version this build does not support", () => {
    const registry = new EffectRegistry();
    expect(() => registry.register({ ...blur, apiVersion: 2 })).toThrow(
      'Effect "gaussian-blur" targets extension API version 2',
    );
    expect(() => registry.register({ ...blur, apiVersion: 0 })).toThrow("targets extension API");
  });

  it("rejects parameters on a non-configurable effect (FX-FW-NOCONFIG-01)", () => {
    const registry = new EffectRegistry();
    const schema = definePropertySchema({
      properties: [{ kind: "boolean", key: "flag", label: "app.name", defaultValue: false }],
    });
    expect(() => registry.register({ ...blur, configurable: false, schema })).toThrow(
      "must not declare parameters",
    );
    expect(() => registry.register({ ...blur, configurable: false })).not.toThrow();
  });
});

describe("FileTypeRegistry", () => {
  it("registers a factory's file types in order", () => {
    const registry = new FileTypeRegistry();
    const host = { services: {} } as FileTypeHost;
    registry.registerFactory(
      () => [png, { ...png, id: "png-copy", loadExtensions: [".pngx"] }],
      host,
    );
    expect(registry.list().map((type) => type.id)).toEqual(["png", "png-copy"]);
  });

  it("rejects extensions that are not lowercase and dot-prefixed", () => {
    const registry = new FileTypeRegistry();
    expect(() => registry.register({ ...png, loadExtensions: ["png"] })).toThrow(
      'invalid extension "png"',
    );
    expect(() => registry.register({ ...png, saveExtensions: [".PNG"] })).toThrow(
      'invalid extension ".PNG"',
    );
  });

  it("requires extensions exactly when the capability is declared", () => {
    const registry = new FileTypeRegistry();
    expect(() => registry.register({ ...png, saveExtensions: [] })).toThrow(
      "supports saving but declares no save extensions",
    );
    const loadOnly = {
      ...png,
      id: "dds",
      saveExtensions: [],
      capabilities: { ...png.capabilities, supportsSaving: false },
    };
    expect(() => registry.register(loadOnly)).not.toThrow();
    expect(() => registry.register({ ...loadOnly, id: "bad", saveExtensions: [".dds"] })).toThrow(
      "declares save extensions but does not support saving",
    );
  });
});

describe("ToolRegistry", () => {
  it("accepts single-letter hotkeys only", () => {
    const registry = new ToolRegistry();
    registry.register(tool);
    expect(registry.get("paintbrush")).toBe(tool);
    expect(() => registry.register({ ...tool, id: "two", hotkey: "BB" })).toThrow(
      "single letter as its hotkey",
    );
  });
});

describe("ShapeRegistry", () => {
  it("requires path data that starts with a move command and a category", () => {
    const registry = new ShapeRegistry();
    registry.register(rectangle);
    expect(() =>
      registry.register({
        ...rectangle,
        id: "bad",
        geometry: { path: "L 1,1", fillRule: "nonzero" },
      }),
    ).toThrow("must have SVG path data that starts with a move command");
    expect(() => registry.register({ ...rectangle, id: "nocat", category: "" })).toThrow(
      "must belong to a category",
    );
  });
});
