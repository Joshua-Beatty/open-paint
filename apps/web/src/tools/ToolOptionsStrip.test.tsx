import { enUS, t } from "@openpaint/i18n";
import type { SettingsStore } from "@openpaint/storage";
import { inlineValueText } from "@openpaint/ui";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PenInputTracker } from "../settings/pen-input";
import { fieldPaths } from "../settings/settings-schema";
import { optionBlockOf, TOOL_REGISTRY, toolShowsOption } from "./roster";
import { ToolOptionsStrip } from "./ToolOptionsStrip";

afterEach(cleanup);

function storeWith(values: Record<string, unknown>): SettingsStore {
  return {
    get: (path: string) => values[path],
    set: (path: string, value: unknown) => {
      values[path] = value;
    },
    onChange: () => () => undefined,
  } as unknown as SettingsStore;
}

/** A tracker that has seen a pen. */
function penSeen(): PenInputTracker {
  const pen = new PenInputTracker();
  pen.remember();
  return pen;
}

const widthLabel = enUS["settings.field.tool.drawWidth"];
const swapLabel = enUS["tool.selection.swap"];

function renderFor(drawMode: string) {
  const tool = TOOL_REGISTRY.get("rectangleSelect");
  if (tool === undefined) throw new Error("no rectangleSelect");
  const settings = storeWith({ "tools.selection.drawMode": drawMode });
  render(<ToolOptionsStrip tool={tool} settings={settings} gpuPerformanceClass="VeryLow" />);
}

describe("ToolOptionsStrip Finish button (TL-FRAME-01)", () => {
  it("shows Finish for a commit-capable tool and calls it", () => {
    const tool = TOOL_REGISTRY.get("magicWand");
    if (tool === undefined) throw new Error("no magicWand");
    const onFinish = vi.fn();
    render(
      <ToolOptionsStrip
        tool={tool}
        settings={storeWith({})}
        gpuPerformanceClass="VeryLow"
        onFinish={onFinish}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: enUS["tool.finish"] }));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("hides Finish for a tool that is not commit-capable", () => {
    const tool = TOOL_REGISTRY.get("rectangleSelect");
    if (tool === undefined) throw new Error("no rectangleSelect");
    render(
      <ToolOptionsStrip
        tool={tool}
        settings={storeWith({})}
        gpuPerformanceClass="VeryLow"
        onFinish={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: enUS["tool.finish"] })).toBeNull();
  });
});

/** The value a drop-down button shows; the hidden values beside it only size the button. */
function shownValue(button: HTMLElement): string | null | undefined {
  return button.querySelector(".prop-select-current")?.textContent;
}

/** Opens a drop-down of the strip by its name and picks one of its values. */
function choose(name: string, value: string) {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(name) }));
  fireEvent.click(screen.getByRole("option", { name: value }));
}

describe("ToolOptionsStrip on/off drop-downs (TL-OPT-AA, TL-OPT-FLOOD, TL-OPT-PICKER)", () => {
  for (const id of ["magicWand", "paintBucket", "colorPicker"]) {
    it(`shows ${id}'s Layer/Image sampling as a drop-down with icons`, () => {
      const tool = TOOL_REGISTRY.get(id);
      if (tool === undefined) throw new Error(`no ${id}`);
      const values: Record<string, unknown> = { "tools.sampleAllLayers": false };
      render(
        <ToolOptionsStrip tool={tool} settings={storeWith(values)} gpuPerformanceClass="VeryLow" />,
      );
      const name = enUS["settings.field.tool.sampleAllLayers"];
      expect(screen.queryByRole("checkbox", { name })).toBeNull();
      const button = screen.getByRole("button", { name: new RegExp(name) });
      expect(shownValue(button)).toBe("Sampling: Layer");
      expect(button.querySelector("svg.prop-icon path")).not.toBeNull();
      fireEvent.click(button);
      const options = screen.getAllByRole("option");
      expect(options.map((option) => option.textContent)).toEqual([
        "Sample the active layer",
        "Sample the whole image",
      ]);
      expect(options.every((option) => option.querySelector("svg path") !== null)).toBe(true);
      fireEvent.click(screen.getByRole("option", { name: "Sample the whole image" }));
      expect(values["tools.sampleAllLayers"]).toBe(true);
    });
  }

  it("shows every on/off option of the options bar as a drop-down, not a checkbox or toggle", () => {
    for (const tool of TOOL_REGISTRY.list()) {
      render(
        <ToolOptionsStrip tool={tool} settings={storeWith({})} gpuPerformanceClass="VeryLow" />,
      );
      expect(screen.queryAllByRole("checkbox"), tool.id).toEqual([]);
      expect(
        screen.queryAllByRole("button").filter((button) => button.hasAttribute("aria-pressed")),
        tool.id,
      ).toHaveLength(tool.id === "text" ? 4 : 0);
      cleanup();
    }
  });

  it("switches antialiasing and pressure through their drop-downs", () => {
    const tool = TOOL_REGISTRY.get("paintbrush");
    if (tool === undefined) throw new Error("no paintbrush");
    const values: Record<string, unknown> = {
      "tools.antialiasing": true,
      "tools.brush.pressure": true,
    };
    render(
      <ToolOptionsStrip
        tool={tool}
        settings={storeWith(values)}
        gpuPerformanceClass="VeryLow"
        pen={penSeen()}
      />,
    );
    expect(
      shownValue(
        screen.getByRole("button", { name: new RegExp(enUS["settings.field.tool.antialiasing"]) }),
      ),
    ).toBe("Antialiased");
    choose(enUS["settings.field.tool.antialiasing"], "Aliased rendering");
    expect(values["tools.antialiasing"]).toBe(false);
    choose(enUS["settings.field.tool.pressure"], "Disable pressure sensitivity");
    expect(values["tools.brush.pressure"]).toBe(false);
  });

  it("shows selection quality only while the image has a selection (TL-OPT-SELQ, owner request)", () => {
    const name = new RegExp(enUS["settings.field.tool.selectionQuality"]);
    for (const tool of TOOL_REGISTRY.list()) {
      if (!toolShowsOption(tool.id, "selection.renderingQuality")) continue;
      const { rerender } = render(
        <ToolOptionsStrip
          tool={tool}
          settings={storeWith({})}
          gpuPerformanceClass="VeryLow"
          hasSelection={false}
        />,
      );
      expect(screen.queryByRole("button", { name }), tool.id).toBeNull();
      rerender(
        <ToolOptionsStrip
          tool={tool}
          settings={storeWith({})}
          gpuPerformanceClass="VeryLow"
          hasSelection
        />,
      );
      expect(screen.getByRole("button", { name }), tool.id).toBeDefined();
      cleanup();
    }
  });

  it("shows the gradient's channels as Color or Transparency", () => {
    const tool = TOOL_REGISTRY.get("gradient");
    if (tool === undefined) throw new Error("no gradient");
    const values: Record<string, unknown> = { "tools.gradient.alphaOnly": false };
    render(
      <ToolOptionsStrip tool={tool} settings={storeWith(values)} gpuPerformanceClass="VeryLow" />,
    );
    choose(enUS["settings.field.tool.alphaOnly"], "Transparency mode");
    expect(values["tools.gradient.alphaOnly"]).toBe(true);
  });
});

/** The text a control shows, without the hidden native select that drop-downs keep for forms. */
function shownText(control: Element): string {
  const copy = control.cloneNode(true) as Element;
  for (const select of copy.querySelectorAll("select")) select.remove();
  return copy.textContent ?? "";
}

const SIZE_PATHS = [
  "tools.selection.drawWidth",
  "tools.selection.drawHeight",
  "tools.selection.drawUnits",
];

describe("ToolOptionsStrip shows each option once (TL-ROSTER-01, TL-OPT-AA, TL-OPT-SELQ)", () => {
  it("binds no setting to two controls of one tool's options bar", () => {
    for (const tool of TOOL_REGISTRY.list()) {
      const paths = optionBlockOf(tool.id).fields.flatMap(fieldPaths);
      expect(paths, tool.id).toEqual([...new Set(paths)]);
    }
  });

  it("renders one control per option, and Antialiasing once", () => {
    for (const tool of TOOL_REGISTRY.list()) {
      const { container } = render(
        <ToolOptionsStrip
          tool={tool}
          settings={storeWith({})}
          gpuPerformanceClass="VeryLow"
          pen={penSeen()}
        />,
      );
      const controls = [...container.querySelectorAll(".prop-control.is-inline")];
      // The Text tool shows its own font list, and Any Size hides Rectangle Select's size boxes.
      const replaced = ["tools.text.fontFamily", ...SIZE_PATHS];
      const fields = optionBlockOf(tool.id).fields.filter(
        (field) => !replaced.includes(field.path),
      );
      expect(controls, tool.id).toHaveLength(fields.length);
      const antialiasing = controls.filter((control) => /antialias/i.test(shownText(control)));
      expect(antialiasing.length, tool.id).toBe(toolShowsOption(tool.id, "antialiasing") ? 1 : 0);
      cleanup();
    }
  });

  it("names the selection quality by the selection edge, apart from Antialiasing", () => {
    const tool = TOOL_REGISTRY.get("paintbrush");
    if (tool === undefined) throw new Error("no paintbrush");
    render(<ToolOptionsStrip tool={tool} settings={storeWith({})} gpuPerformanceClass="VeryLow" />);
    const quality = screen.getByRole("button", {
      name: new RegExp(enUS["settings.field.tool.selectionQuality"]),
    });
    expect(shownValue(quality)).toBe("Selection: Smooth");
    fireEvent.click(quality);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Antialiased selection quality",
      "Pixelated selection quality",
    ]);
  });
});

/**
 * Drop-down values that say on their own what they choose, without a "Name:" caption. Every other
 * value of an options-bar drop-down must read "Name: value".
 */
const SELF_DESCRIBING = new Set([
  "Round tip",
  "Square tip",
  "Antialiased",
  "Aliased",
  "Premultiplied",
  "Straight alpha",
  "Sample once",
  "Match secondary",
  "Solid line",
  "Dashes",
  "Dotted",
  "Dash dot",
  "Dash dot dot",
  "Any Size",
  "Fixed Ratio",
  "Fixed Size",
  "Pixels",
  "Inches",
  "Centimeters",
  "Gamma Corrected",
  "Ignore Gamma",
  "No repeat",
  "Repeat, wrapped",
  "Repeat, reflected",
  "Points",
  "Fixed 96 DPI",
]);

/** The accessible name of an element, from aria-labelledby, aria-label or its text. */
function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy !== null && labelledBy !== "") {
    return labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
  }
  return (element.getAttribute("aria-label") ?? element.textContent ?? "").trim();
}

describe("ToolOptionsStrip labels (UI-TB-03, WEB-A11Y-01)", () => {
  it("shows every drop-down value under a name, or as a value that names itself", () => {
    const blocks = TOOL_REGISTRY.list().map((tool) => [tool.id, tool.options] as const);
    const unclear: string[] = [];
    for (const [id, schema] of blocks) {
      for (const property of schema?.properties ?? []) {
        const values =
          property.kind === "choice"
            ? property.options.map((option) => option.value)
            : property.kind === "boolean"
              ? [true, false]
              : [];
        for (const value of values) {
          const text = inlineValueText(property, value, t);
          if (text === undefined) {
            unclear.push(`${id} ${property.key}: no drop-down text`);
          } else if (!text.includes(": ") && !SELF_DESCRIBING.has(text)) {
            unclear.push(`${id} ${property.key}: "${text}"`);
          }
        }
      }
    }
    expect(unclear).toEqual([]);
  });

  it("lists the values of on/off drop-downs as full phrases", () => {
    for (const tool of TOOL_REGISTRY.list()) {
      for (const property of tool.options?.properties ?? []) {
        const choices = property.control?.booleanChoices;
        if (choices === undefined) continue;
        for (const choice of [choices.on, choices.off]) {
          expect(t(choice.label).split(" ").length, `${tool.id} ${property.key}`).toBeGreaterThan(
            1,
          );
          expect(t(choice.label)).not.toBe(t(choice.shortLabel ?? choice.label));
        }
      }
    }
  });

  it("shows path smoothing as 'Smoothing: On' with 'Enable/Disable path smoothing' in its list", () => {
    const tool = TOOL_REGISTRY.get("paintbrush");
    if (tool === undefined) throw new Error("no paintbrush");
    const values: Record<string, unknown> = { "tools.inputSmoothing": "Enabled" };
    render(
      <ToolOptionsStrip tool={tool} settings={storeWith(values)} gpuPerformanceClass="VeryLow" />,
    );
    const name = enUS["settings.field.tool.inputSmoothing"];
    const button = screen.getByRole("button", { name: new RegExp(name) });
    expect(shownValue(button)).toBe("Smoothing: On");
    fireEvent.click(button);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Enable path smoothing",
      "Disable path smoothing",
    ]);
    fireEvent.click(screen.getByRole("option", { name: "Disable path smoothing" }));
    expect(values["tools.inputSmoothing"]).toBe("Disabled");
  });

  it("names every control of every options bar and shows a label or value on each", () => {
    for (const tool of TOOL_REGISTRY.list()) {
      for (const drawMode of tool.id === "rectangleSelect" ? ["Normal", "FixedSize"] : ["Normal"]) {
        const { container } = render(
          <ToolOptionsStrip
            tool={tool}
            settings={storeWith({ "tools.selection.drawMode": drawMode })}
            gpuPerformanceClass="VeryLow"
          />,
        );
        const interactive = [
          ...container.querySelectorAll(
            'button, input, textarea, [role="slider"], [role="combobox"], [role="radio"]',
          ),
        ].filter(
          (element) =>
            element.closest('[hidden], [aria-hidden="true"], [data-react-aria-prevent-focus]') ===
            null,
        );
        expect(interactive.length, tool.id).toBeGreaterThanOrEqual(
          optionBlockOf(tool.id).fields.length > 0 ? 1 : 0,
        );
        for (const element of interactive) {
          expect(
            accessibleName(element),
            `${tool.id}: ${element.outerHTML.slice(0, 120)}`,
          ).not.toBe("");
        }
        for (const control of container.querySelectorAll(".prop-control.is-inline")) {
          expect(
            shownText(control).trim(),
            `${tool.id}: ${control.outerHTML.slice(0, 120)}`,
          ).not.toBe("");
        }
        cleanup();
      }
    }
  });
});

describe("ToolOptionsStrip Fill drop-down (TL-OPT-FILL)", () => {
  for (const id of ["paintBucket", "paintbrush", "lineCurve", "shapes"]) {
    it(`shows ${id}'s fill as one drop-down of Solid and the hatch patterns`, () => {
      const tool = TOOL_REGISTRY.get(id);
      if (tool === undefined) throw new Error(`no ${id}`);
      const values: Record<string, unknown> = {
        "tools.brush.fillType": "Solid",
        "tools.brush.hatchStyle": "BackwardDiagonal",
      };
      render(
        <ToolOptionsStrip tool={tool} settings={storeWith(values)} gpuPerformanceClass="VeryLow" />,
      );
      const name = enUS["settings.field.tool.fillType"];
      const fills = screen.getAllByRole("button", { name: new RegExp(`\\b${name}\\b`) });
      expect(fills).toHaveLength(1);
      fireEvent.click(fills[0] as HTMLElement);
      const options = screen.getAllByRole("option");
      expect(options.map((option) => option.textContent)).toEqual([
        "Solid",
        "Horizontal",
        "Vertical",
        "Forward diagonal",
        "Backward diagonal",
        "Cross",
        "Diagonal cross",
        "50% gray",
        "Dotted grid",
      ]);
      expect(options.every((option) => option.querySelector("svg path") !== null)).toBe(true);
      fireEvent.click(screen.getByRole("option", { name: "Cross" }));
      expect(values["tools.brush.fillType"]).toBe("Hatch");
      expect(values["tools.brush.hatchStyle"]).toBe("Cross");
      choose(name, "Solid");
      expect(values["tools.brush.fillType"]).toBe("Solid");
      expect(values["tools.brush.hatchStyle"]).toBe("Cross");
    });
  }
});

describe("ToolOptionsStrip sliders (TL-OPT-BRUSH, TL-OPT-FLOOD)", () => {
  function renderTool(id: string, values: Record<string, unknown> = {}) {
    const tool = TOOL_REGISTRY.get(id);
    if (tool === undefined) throw new Error(`no ${id}`);
    render(
      <ToolOptionsStrip tool={tool} settings={storeWith(values)} gpuPerformanceClass="VeryLow" />,
    );
  }

  it("shows the bounded options as percentage sliders and keeps brush size a preset box", () => {
    renderTool("recolor", {
      "tools.brush.hardness": 0.75,
      "tools.brush.spacing": 0.15,
      "tools.tolerance": 0.5,
    });
    const text = (name: string) =>
      screen
        .getByRole("slider", { name: enUS[name as keyof typeof enUS] })
        .getAttribute("aria-valuetext");
    expect(text("settings.field.tool.hardness")).toBe("75%");
    expect(text("settings.field.tool.spacing")).toBe("15%");
    expect(text("settings.field.tool.tolerance")).toBe("50%");
    expect(screen.getAllByRole("slider")).toHaveLength(3);
    expect(screen.getByRole("combobox", { name: enUS["settings.field.tool.size"] })).toBeTruthy();
    expect(screen.queryAllByRole("textbox")).toEqual([]);
  });

  it("writes slider changes to the settings as fractions", () => {
    const values: Record<string, unknown> = { "tools.brush.hardness": 0.75 };
    renderTool("paintbrush", values);
    const slider = screen.getByRole("slider", { name: enUS["settings.field.tool.hardness"] });
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(values["tools.brush.hardness"]).toBe(0.74);
  });

  it("keeps the open-ended Width and Height as number boxes", () => {
    renderFor("FixedSize");
    expect(screen.queryAllByRole("slider")).toEqual([]);
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
  });
});

describe("ToolOptionsStrip pressure option (WEB-PTR-02)", () => {
  const pressure = () =>
    screen.queryByRole("button", { name: new RegExp(enUS["settings.field.tool.pressure"]) });

  function renderBrush(values: Record<string, unknown>, pen?: PenInputTracker) {
    const tool = TOOL_REGISTRY.get("paintbrush");
    if (tool === undefined) throw new Error("no paintbrush");
    render(
      <ToolOptionsStrip
        tool={tool}
        settings={storeWith(values)}
        gpuPerformanceClass="VeryLow"
        {...(pen === undefined ? {} : { pen })}
      />,
    );
  }

  it("hides the pressure option until a pen is seen, keeping its stored value", () => {
    const values: Record<string, unknown> = { "tools.brush.pressure": false };
    renderBrush(values);
    expect(pressure()).toBeNull();
    cleanup();
    renderBrush(values, new PenInputTracker());
    expect(pressure()).toBeNull();
    expect(values["tools.brush.pressure"]).toBe(false);
  });

  it("shows the pressure option as soon as a pen sends a pointer event", () => {
    const target = new EventTarget();
    const pen = new PenInputTracker();
    pen.start(target);
    renderBrush({ "tools.brush.pressure": true }, pen);
    expect(pressure()).toBeNull();
    const event = new Event("pointerdown");
    Object.defineProperty(event, "pointerType", { value: "pen" });
    act(() => {
      target.dispatchEvent(event);
    });
    expect(shownValue(pressure() as HTMLElement)).toBe("Pressure: On");
  });

  it("shows the pressure option when an earlier session saw a pen", () => {
    renderBrush({ "tools.brush.pressure": true }, penSeen());
    expect(pressure()).not.toBeNull();
  });
});

describe("ToolOptionsStrip for Rectangle Select (TL-SEL-RECT-01)", () => {
  it("hides the Width, Height, units boxes and the swap button in Any Size", () => {
    renderFor("Normal");
    expect(screen.queryByText(widthLabel)).toBeNull();
    expect(screen.queryByRole("button", { name: swapLabel })).toBeNull();
    expect(
      screen.getByRole("button", { name: new RegExp(enUS["settings.field.tool.drawMode"]) }),
    ).toBeTruthy();
  });

  it("shows the size boxes and the swap button in Fixed Ratio and Fixed Size", () => {
    renderFor("FixedSize");
    expect(screen.getByText(widthLabel)).toBeTruthy();
    expect(screen.getByRole("button", { name: swapLabel })).toBeTruthy();
  });
});
