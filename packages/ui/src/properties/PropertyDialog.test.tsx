// @vitest-environment jsdom
import {
  definePropertySchema,
  type PropertySchema,
  type PropertyValues,
} from "@openpaint/properties";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PropertyDialog, type PropertyDialogProps } from "./PropertyDialog";
import type { PropertyServices } from "./services";

/** One property per control type (EXT-06C-01), plus a boolean that a read-only rule depends on. */
const schema: PropertySchema = definePropertySchema({
  properties: [
    {
      kind: "boolean",
      key: "locked",
      label: "history.property.visible",
      defaultValue: false,
      control: { controlType: "checkbox", description: "layers.dialog.visible" },
    },
    {
      kind: "double",
      key: "radius",
      label: "property.radius",
      defaultValue: 2,
      min: 0,
      max: 10,
      control: {
        decimalPlaces: 1,
        sliderSmallChange: 0.5,
        sliderLargeChange: 2,
        footnote: "property.quality",
        showResetButton: true,
      },
    },
    {
      kind: "double",
      key: "angle",
      label: "property.gammaBoost",
      defaultValue: 175,
      min: -180,
      max: 180,
      control: { controlType: "anglePicker", rangeWraps: true, sliderLargeChange: 36 },
    },
    {
      kind: "int32",
      key: "seed",
      label: "property.quality",
      defaultValue: 255,
      min: 0,
      max: 255,
      control: {
        controlType: "incrementButton",
        buttonText: "property.randomize",
        rangeWraps: true,
      },
    },
    {
      kind: "choice",
      key: "mode",
      label: "layers.dialog.blendMode",
      defaultValue: "normal",
      options: [
        { value: "normal", label: "blend.normal" },
        { value: "multiply", label: "blend.multiply" },
      ],
      control: { controlType: "dropdown" },
    },
    {
      kind: "choice",
      key: "style",
      label: "history.property.opacity",
      defaultValue: "x",
      options: [
        { value: "x", label: "blend.lighten" },
        { value: "y", label: "blend.darken" },
      ],
      control: { controlType: "radioButtons" },
    },
    {
      kind: "string",
      key: "text",
      label: "layers.dialog.name",
      defaultValue: "Hello",
      maxLength: 8,
      control: { controlType: "textBox" },
    },
    {
      kind: "string",
      key: "file",
      label: "fileDialog.selectFile",
      defaultValue: "",
      control: { controlType: "filePicker", fileTypes: [".png"], allowAllFiles: true },
    },
    {
      kind: "string",
      key: "folder",
      label: "colors.primary",
      defaultValue: "",
      control: { controlType: "folderPicker" },
    },
    {
      kind: "uri",
      key: "url",
      label: "effect.gaussianBlur",
      defaultValue: "https:example.com",
      control: { controlType: "link" },
    },
    {
      kind: "color",
      key: "color",
      label: "colors.secondary",
      defaultValue: { r: 1, g: 0, b: 0, a: 1 },
      alphaMode: "supportsAlpha",
      control: { controlType: "colorWheel" },
    },
    {
      kind: "vector2",
      key: "pan",
      label: "history.flatten",
      defaultValue: { x: 0, y: 0 },
      min: { x: -1, y: -1 },
      max: { x: 1, y: 1 },
      control: { controlType: "panAndSliders", staticImageUnderlay: "thumb" },
    },
    {
      kind: "vector3",
      key: "roll",
      label: "history.resize",
      defaultValue: { x: 0, y: 0, z: 0 },
      min: { x: -180, y: -180, z: 0 },
      max: { x: 180, y: 180, z: 90 },
      control: { controlType: "trackballAndSliders" },
    },
    {
      kind: "string",
      key: "caption",
      label: "history.newLayer",
      defaultValue: "Read only text",
      control: { controlType: "label" },
    },
    {
      kind: "double",
      key: "hiddenValue",
      label: "history.newImage",
      defaultValue: 3,
      min: 0,
      max: 10,
      control: { controlType: "hidden" },
    },
  ],
  rules: [{ kind: "readOnlyWhenBoolean", target: "radius", source: "locked" }],
});

function renderDialog(overrides: Partial<PropertyDialogProps> = {}) {
  const onOk = vi.fn<(values: PropertyValues) => void>();
  const onCancel = vi.fn();
  render(
    <PropertyDialog
      isOpen
      schema={schema}
      title="Test Effect"
      onOk={onOk}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onOk, onCancel };
}

function lastOk(onOk: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } }) {
  const values = onOk.mock.calls.at(-1)?.[0] as PropertyValues | undefined;
  if (values === undefined) throw new Error("OK was not pressed");
  return values;
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PropertyDialog: control types", () => {
  it("shows the title, then one control per property in declaration order, with the schema's roles", () => {
    renderDialog({ services: { resolveImage: () => undefined } });
    expect(screen.getByRole("dialog", { name: "Test Effect" })).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "Visible" })).toBeDefined();
    expect(screen.getByRole("slider", { name: "Radius" })).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Radius value" })).toBeDefined();
    expect(screen.getByRole("slider", { name: "Gamma Boost" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Randomize" })).toBeDefined();
    expect(screen.getByRole("button", { name: /^Normal Blend Mode$/ })).toBeDefined();
    expect(screen.getByRole("radiogroup", { name: "Opacity" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "Lighten" })).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Name" })).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Select File" })).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Primary color" })).toBeDefined();
    expect(screen.getByRole("link", { name: "https:example.com" })).toBeDefined();
    expect(screen.getByRole("slider", { name: "Saturation" })).toBeDefined();
    expect(screen.getByRole("slider", { name: "Flatten X" })).toBeDefined();
    expect(screen.getByRole("slider", { name: "Resize Z" })).toBeDefined();
    expect(screen.getByText("Read only text")).toBeDefined();
  });

  it("renders no control for a hidden property", () => {
    renderDialog();
    expect(screen.queryByText("New Image")).toBeNull();
  });

  it("does not offer a file browse button without a host file picker", () => {
    renderDialog();
    expect(screen.queryByRole("button", { name: "Browse..." })).toBeNull();
  });

  it("points links at a new tab with the URL as the tooltip", () => {
    renderDialog();
    const link = screen.getByRole("link", { name: "https:example.com" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("title")).toBe("https:example.com");
  });

  it("shows a control's footnote, and an alpha slider for a color with alpha", () => {
    renderDialog();
    expect(screen.getByText("Quality")).toBeDefined();
    expect(screen.getByRole("slider", { name: "Alpha" })).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Alpha value" })).toBeDefined();
  });

  it("draws the pan pad with the image the host resolves for its underlay", () => {
    render(
      <PropertyDialog
        isOpen
        schema={schema}
        title="Test Effect"
        services={{
          resolveImage: (key) => (key === "thumb" ? "https://example.test/thumb.png" : undefined),
        }}
        onOk={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const pad = document.querySelector(".prop-pad");
    expect(pad?.getAttribute("style") ?? "").toContain("https://example.test/thumb.png");
  });
});

describe("PropertyDialog: keyboard", () => {
  it("moves a slider with the arrow, page and end keys", () => {
    renderDialog();
    const slider = screen.getByRole("slider", { name: "Radius" });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(slider.getAttribute("aria-valuenow")).toBe("2.5");
    fireEvent.keyDown(slider, { key: "PageUp" });
    expect(slider.getAttribute("aria-valuenow")).toBe("4.5");
    fireEvent.keyDown(slider, { key: "End" });
    expect(slider.getAttribute("aria-valuenow")).toBe("10");
    fireEvent.keyDown(slider, { key: "Home" });
    expect(slider.getAttribute("aria-valuenow")).toBe("0");
  });

  it("wraps an angle at its end when the range wraps", () => {
    renderDialog();
    const dial = screen.getByRole("slider", { name: "Gamma Boost" });
    fireEvent.keyDown(dial, { key: "PageUp" });
    expect(dial.getAttribute("aria-valuenow")).toBe("-180");
  });

  it("closes through Esc without applying anything", () => {
    const { onOk, onCancel } = renderDialog();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape", code: "Escape" });
    expect(onCancel).toHaveBeenCalled();
    expect(onOk).not.toHaveBeenCalled();
  });
});

describe("PropertyDialog: values, OK and Cancel", () => {
  it("returns every value on OK, with edits applied", () => {
    const { onOk } = renderDialog();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Ink" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Visible" }));
    fireEvent.click(screen.getByRole("radio", { name: "Darken" }));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    const values = lastOk(onOk);
    expect(values.text).toBe("Ink");
    expect(values.locked).toBe(true);
    expect(values.style).toBe("y");
    expect(values.hiddenValue).toBe(3);
  });

  it("truncates text to its maximum length", () => {
    const { onOk } = renderDialog();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "A very long name" },
    });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(lastOk(onOk).text).toBe("A very l");
  });

  it("calls Cancel and never OK", () => {
    const { onOk, onCancel } = renderDialog();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Ink" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onOk).not.toHaveBeenCalled();
  });

  it("cancels from the close button in the title bar, like Cancel", () => {
    const { onOk, onCancel } = renderDialog();
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.closest(".modal-header")?.textContent).toBe("Test Effect");
    fireEvent.click(close);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onOk).not.toHaveBeenCalled();
  });

  it("starts from the given values and reports every change while open", () => {
    const onValuesChange = vi.fn();
    const { onOk } = renderDialog({ values: { radius: 7, text: "Saved" }, onValuesChange });
    expect(screen.getByRole("slider", { name: "Radius" }).getAttribute("aria-valuenow")).toBe("7");
    fireEvent.keyDown(screen.getByRole("slider", { name: "Radius" }), { key: "ArrowLeft" });
    expect(onValuesChange).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(lastOk(onOk).radius).toBe(6.5);
  });

  it("restores the schema default from a reset button, not the last saved value", () => {
    const { onOk } = renderDialog({ values: { radius: 9 } });
    fireEvent.click(screen.getByRole("button", { name: "Reset Radius" }));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(lastOk(onOk).radius).toBe(2);
  });

  it("wraps the seed from its maximum back to 0 on Randomize", () => {
    const { onOk } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Randomize" }));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(lastOk(onOk).seed).toBe(0);
  });

  it("writes the picked color channel back into the color value", () => {
    const { onOk } = renderDialog();
    fireEvent.change(screen.getByRole("textbox", { name: "Red value" }), {
      target: { value: "128" },
    });
    fireEvent.blur(screen.getByRole("textbox", { name: "Red value" }));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    const color = lastOk(onOk).color as { r: number; g: number; b: number; a: number };
    expect(color.r).toBeCloseTo(128 / 255, 10);
    expect(color.g).toBe(0);
  });

  it("chooses a drop-down item", () => {
    const { onOk } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /^Normal Blend Mode$/ }));
    fireEvent.click(screen.getByRole("option", { name: "Multiply" }));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(lastOk(onOk).mode).toBe("multiply");
  });
});

describe("PropertyDialog: rules", () => {
  it("makes a read-only target disabled while its boolean source is set", () => {
    renderDialog();
    const radius = screen.getByRole("slider", { name: "Radius" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Visible" }));
    expect(radius.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(radius, { key: "ArrowRight" });
    expect(radius.getAttribute("aria-valuenow")).toBe("2");
  });
});

describe("PropertyDialog: host services", () => {
  it("fills a file path from the host's picker, with the control's file-type filter", async () => {
    const pickFile = vi.fn<NonNullable<PropertyServices["pickFile"]>>(async () => "/tmp/a.png");
    const { onOk } = renderDialog({ services: { pickFile } });
    fireEvent.click(screen.getByRole("button", { name: "Browse..." }));
    await waitFor(() => {
      expect((screen.getByRole("textbox", { name: "Select File" }) as HTMLInputElement).value).toBe(
        "/tmp/a.png",
      );
    });
    expect(pickFile).toHaveBeenCalledWith({ fileTypes: [".png"], allowAllFiles: true });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(lastOk(onOk).file).toBe("/tmp/a.png");
  });

  it("keeps the value when the file picker is cancelled", async () => {
    const pickFile = vi.fn<NonNullable<PropertyServices["pickFile"]>>(async () => undefined);
    renderDialog({ services: { pickFile } });
    fireEvent.click(screen.getByRole("button", { name: "Browse..." }));
    await waitFor(() => expect(pickFile).toHaveBeenCalled());
    expect((screen.getByRole("textbox", { name: "Select File" }) as HTMLInputElement).value).toBe(
      "",
    );
  });

  it("shows a folder chooser as a plain text field when there is no directory picker", () => {
    renderDialog();
    const folder = screen.getByRole("textbox", { name: "Primary color" });
    expect(folder).toBeDefined();
    expect(screen.queryAllByRole("button", { name: "Browse..." })).toHaveLength(0);
  });
});

describe("PropertyDialog: dialog options and layout", () => {
  it("uses the schema's custom title and shows a plain-text help box", () => {
    const helpSchema = definePropertySchema({
      properties: [
        {
          kind: "double",
          key: "a",
          label: "property.radius",
          defaultValue: 1,
          min: 0,
          max: 2,
          control: {
            dialogTitle: "history.layerProperties",
            dialogHelpContentType: "plainText",
            dialogHelpContent: "Pick a value between zero and two.",
          },
        },
      ],
    });
    render(
      <PropertyDialog
        isOpen
        schema={helpSchema}
        title="Ignored"
        onOk={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Layer Properties" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    expect(screen.getByText("Pick a value between zero and two.")).toBeDefined();
  });

  it("shows catalog help in the dialog's language and an inline notice", () => {
    const helpSchema = definePropertySchema({
      properties: [
        {
          kind: "boolean",
          key: "a",
          label: "property.noCaption",
          defaultValue: false,
          control: {
            description: "property.showFaintPixels",
            dialogHelpMessage: "property.alignObjectHelp",
          },
        },
      ],
    });
    render(
      <PropertyDialog
        isOpen
        schema={helpSchema}
        title="Align Object"
        notice="Nothing will be aligned."
        onOk={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("Nothing will be aligned.");
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    expect(
      screen.getByText(/Align Object is meant for an object on a transparent layer/),
    ).toBeDefined();
  });

  it("passes a custom help content to the host", () => {
    const onHelpRequested = vi.fn();
    const helpSchema = definePropertySchema({
      properties: [
        {
          kind: "double",
          key: "a",
          label: "property.radius",
          defaultValue: 1,
          min: 0,
          max: 2,
          control: { dialogHelpContentType: "custom", dialogHelpContent: "help/radius" },
        },
      ],
    });
    render(
      <PropertyDialog
        isOpen
        schema={helpSchema}
        title="Test Effect"
        services={{ onHelpRequested }}
        onOk={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    expect(onHelpRequested).toHaveBeenCalledWith("help/radius");
  });

  it("scales the dialog width from the schema", () => {
    const wideSchema = definePropertySchema({
      properties: [
        {
          kind: "double",
          key: "a",
          label: "property.radius",
          defaultValue: 1,
          min: 0,
          max: 2,
          control: { dialogWidthScale: 1.5, dialogIsResizable: true },
        },
      ],
    });
    render(
      <PropertyDialog
        isOpen
        schema={wideSchema}
        title="Test Effect"
        onOk={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    const modal = dialog.closest(".prop-dialog");
    expect(modal?.getAttribute("style")).toContain("--prop-dialog-scale: 1.5");
    expect(modal?.classList.contains("is-resizable")).toBe(true);
  });

  it("lays properties out in tab pages and writes the selected tab", () => {
    const tabSchema = definePropertySchema({
      properties: [
        {
          kind: "tabState",
          key: "page",
          label: "history.canvasSize",
          defaultValue: 0,
          tabCount: 2,
        },
        {
          kind: "string",
          key: "first",
          label: "layers.dialog.name",
          defaultValue: "one",
          control: { controlType: "textBox" },
        },
        {
          kind: "string",
          key: "second",
          label: "fileDialog.selectFile",
          defaultValue: "two",
          control: { controlType: "textBox" },
        },
      ],
      layout: [
        {
          kind: "tabs",
          key: "page",
          pages: [
            { label: "property.radius", children: [{ kind: "control", key: "first" }] },
            { label: "property.gammaBoost", children: [{ kind: "control", key: "second" }] },
          ],
        },
      ],
    });
    const onOk = vi.fn<(values: PropertyValues) => void>();
    render(
      <PropertyDialog isOpen schema={tabSchema} title="Tabs" onOk={onOk} onCancel={vi.fn()} />,
    );
    const tabList = screen.getByRole("tablist");
    const tabs = within(tabList).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Radius", "Gamma Boost"]);
    expect(screen.getByRole("textbox", { name: "Name" })).toBeDefined();
    fireEvent.click(screen.getByRole("tab", { name: "Gamma Boost" }));
    expect(screen.getByRole("textbox", { name: "Select File" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(lastOk(onOk).page).toBe(1);
  });
});

describe("PropertyDialog: blank captions (WEB-A11Y-01)", () => {
  it("names a control whose caption is blank after the dialog, in its slider and reset button", () => {
    const captionless = definePropertySchema({
      properties: [
        {
          kind: "int32",
          key: "exposure",
          label: "property.noCaption",
          defaultValue: 0,
          min: -200,
          max: 200,
        },
      ],
    });
    renderDialog({ schema: captionless, title: "Exposure" });
    expect(screen.getByRole("slider", { name: "Exposure" })).toBeDefined();
    expect(screen.getByRole("button", { name: /Exposure/ })).toBeDefined();
  });
});
