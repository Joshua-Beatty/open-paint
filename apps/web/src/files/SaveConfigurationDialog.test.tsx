import { DEFAULT_RESOLUTION, Surface } from "@openpaint/document";
import {
  EXTENSION_API_MAJOR,
  type FileCodec,
  type FileDocument,
  type FileTypeDescriptor,
} from "@openpaint/extension-api";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SaveConfigChoice } from "./file-dialogs";
import { SaveConfigurationDialog } from "./SaveConfigurationDialog";

/** Writes one flag byte, from the "Remove metadata" option, then the pixels. */
const codec: FileCodec = {
  async load() {
    throw new Error("unused");
  },
  async save(file, sink, values) {
    await sink.write(Uint8Array.of(values.removeMetadata === true ? 1 : 0));
    await sink.write(new Uint8Array(file.layers[0]?.surface.data ?? []));
  },
};

const type: FileTypeDescriptor = {
  id: "cfg",
  apiVersion: EXTENSION_API_MAJOR,
  label: "fileType.png",
  icon: "file-raw",
  loadExtensions: [".cfg"],
  saveExtensions: [".cfg"],
  mimeTypes: ["application/x-cfg"],
  capabilities: {
    supportsLayers: false,
    supportsCustomHeaders: false,
    supportsSaving: true,
    supportsLoading: false,
    savesWithProgress: false,
    supportsCancellation: false,
  },
  saveOptions: {
    properties: [
      {
        kind: "boolean",
        key: "removeMetadata",
        label: "fileOption.removeMetadata",
        defaultValue: false,
      },
    ],
  },
  loadCodec: async () => codec,
  isLossless: () => true,
};

function flatFile(): FileDocument {
  return {
    width: 1,
    height: 1,
    resolution: DEFAULT_RESOLUTION,
    colorProfile: "srgb",
    metadata: { xmp: [], user: {} },
    layers: [
      {
        name: "Background",
        visible: true,
        opacity: 255,
        blendMode: 0,
        surface: new Surface(1, 1, new Uint8ClampedArray([1, 2, 3, 255])),
      },
    ],
  };
}

function renderDialog(values: Record<string, boolean> = { removeMetadata: false }) {
  const answers: (SaveConfigChoice | undefined)[] = [];
  render(
    <SaveConfigurationDialog
      type={type}
      codec={codec}
      file={flatFile()}
      values={values}
      answer={(choice) => answers.push(choice)}
    />,
  );
  return answers;
}

describe("SaveConfigurationDialog (FMT-UI-01..03)", () => {
  beforeAll(() => {
    // jsdom has no 2D canvas, so the preview image is skipped; the bytes and size still show.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("builds the options from the schema and shows the encoded size", async () => {
    renderDialog();

    expect(screen.getByRole("dialog", { name: "Save Configuration" })).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "Remove metadata" })).toBeDefined();
    expect(await screen.findByText("Preview, file size: 5 bytes")).toBeDefined();
  });

  it("recomputes the size when an option changes, and answers OK with the values", async () => {
    const answers = renderDialog();
    await screen.findByText("Preview, file size: 5 bytes");

    fireEvent.click(screen.getByRole("checkbox", { name: "Remove metadata" }));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));

    await vi.waitFor(() => {
      expect(answers).toHaveLength(1);
    });
    expect(answers[0]?.values).toEqual({ removeMetadata: true });
    expect(answers[0]?.encoded?.byteLength).toBe(5);
  });

  it("reuses the preview bytes it encoded for the chosen values", async () => {
    const answers = renderDialog({ removeMetadata: true });
    await screen.findByText("Preview, file size: 5 bytes");

    fireEvent.click(screen.getByRole("button", { name: "OK" }));

    await vi.waitFor(() => {
      expect(answers).toHaveLength(1);
    });
    expect([...(answers[0]?.encoded ?? [])]).toEqual([1, 1, 2, 3, 255]);
  });

  it("restores the defaults with the Defaults button", async () => {
    renderDialog({ removeMetadata: true });

    fireEvent.click(screen.getByRole("button", { name: "Defaults" }));

    expect(
      (screen.getByRole("checkbox", { name: "Remove metadata" }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("answers nothing when canceled", () => {
    const answers = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(answers).toEqual([undefined]);
  });
});
