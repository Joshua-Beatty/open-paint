// @vitest-environment jsdom
import { filledIcon } from "@openpaint/properties";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Icon, OptionIcon } from "./icons";

afterEach(cleanup);

describe("Icon", () => {
  it("strokes plain path data on the 16 x 16 grid", () => {
    const { container } = render(<OptionIcon path="M2 8h12" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("class")).toBe("prop-icon");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(svg?.querySelector("path")?.getAttribute("d")).toBe("M2 8h12");
  });

  it("fills an icon set's icon on its own grid, hidden from assistive technology", () => {
    const { container } = render(
      <Icon icon={filledIcon(256, "M28,28H228V228H28Z")} className="tool-icon" />,
    );
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("class")).toBe("tool-icon icon-filled");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 256 256");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.querySelector("path")?.getAttribute("d")).toBe("M28,28H228V228H28Z");
  });
});
