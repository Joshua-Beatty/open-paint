import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import { AppShell } from "./AppShell";

describe("AppShell layout (UI-WIN-01, UI-FTW-01)", () => {
  it("places the menu bar, tool options, tabs, canvas and status bar in order", () => {
    const { container } = render(
      <AppShell
        menuBar={<span>menu</span>}
        commonActions={<span>common</span>}
        toolOptions={<span>options</span>}
        imageTabs={<span>tabs</span>}
        leftSidebar={<span>left</span>}
        rightSidebar={<span>right</span>}
        statusBar={<span>status</span>}
      >
        <span>canvas</span>
      </AppShell>,
    );
    const shell = container.querySelector(".app-shell");
    const order = Array.from(shell?.children ?? []).map((element) => element.className);
    expect(order).toEqual([
      "app-menu-bar",
      "app-tool-options",
      "app-image-tabs",
      "app-sidebar app-sidebar-left",
      "app-canvas-area",
      "app-sidebar app-sidebar-right",
      "app-status-bar",
    ]);
    // The common actions come first in the toolbar area, then the tool options (UI-WIN-01 item 2).
    expect(container.querySelector(".app-tool-options")?.textContent).toBe("commonoptions");
    expect(screen.getByRole("toolbar", { name: "Tool options" })).toBeDefined();
    expect(container.querySelector("footer")?.textContent).toBe("status");
  });

  it("sizes the right column from the given width and focuses the canvas through its ref", () => {
    const canvasRef = createRef<HTMLElement>();
    const { container } = render(
      <AppShell rightSidebar={<span>right</span>} rightSidebarWidth={340} canvasRef={canvasRef}>
        canvas
      </AppShell>,
    );
    const shell = container.querySelector<HTMLElement>(".app-shell");
    expect(shell?.style.gridTemplateColumns).toBe("0px minmax(0, 1fr) 340px");
    canvasRef.current?.focus();
    expect(document.activeElement).toBe(container.querySelector(".app-canvas-area"));
  });

  it("gives a shown sidebar its column and a hidden one none", () => {
    const { container } = render(<AppShell leftSidebar={<span>left</span>}>canvas</AppShell>);
    const shell = container.querySelector<HTMLElement>(".app-shell");
    expect(shell?.style.gridTemplateColumns).toBe("var(--left-sidebar-width) minmax(0, 1fr) 0px");
    expect(container.querySelector(".app-sidebar-right")).toBeNull();
  });
});

describe("AppShell compact layout", () => {
  const compact = { compact: true, short: false, sideSheet: false };
  const shell = (layout: typeof compact | undefined) => (
    <AppShell
      layout={layout}
      menuBar={<span>menu</span>}
      commonActions={<span>common</span>}
      compactStart={<span>start</span>}
      compactEnd={<span>end</span>}
      toolOptions={<span>options</span>}
      leftSidebar={<span>rail</span>}
      rightSidebar={<span>right</span>}
      sheet={<section className="app-sheet">sheet</section>}
      statusBar={<span>status</span>}
    >
      <span>canvas</span>
    </AppShell>
  );

  it("puts the top bar, the rail and the sheet in place of the menu bar and sidebars", () => {
    const { container } = render(shell(compact));
    const root = container.querySelector(".app-shell");
    expect(root?.className).toBe("app-shell is-compact has-rail");
    expect(Array.from(root?.children ?? []).map((element) => element.className)).toEqual([
      "app-compact-start",
      "app-tool-options",
      "app-compact-end",
      "app-sidebar app-sidebar-left",
      "app-canvas-area",
      "app-sheet",
      "app-status-bar",
    ]);
    expect(container.querySelector(".app-tool-options")?.textContent).toBe("options");
  });

  it("keeps the same canvas area element when the layout switches, since the engine lives in it", () => {
    const { container, rerender } = render(shell(undefined));
    const before = container.querySelector(".app-canvas-area");
    rerender(shell(compact));
    expect(container.querySelector(".app-canvas-area")).toBe(before);
    rerender(shell({ compact: true, short: true, sideSheet: true }));
    expect(container.querySelector(".app-canvas-area")).toBe(before);
    expect(container.querySelector(".app-shell")?.className).toContain("is-short is-side-sheet");
    rerender(shell(undefined));
    expect(container.querySelector(".app-canvas-area")).toBe(before);
  });
});
