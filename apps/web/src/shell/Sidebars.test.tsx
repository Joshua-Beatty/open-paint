import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PANEL_LAYOUT, type PanelLayout } from "./panel-layout";
import type { PanelActions } from "./panel-layout-settings";
import { LeftSidebar, RightSidebar } from "./Sidebars";

function actionsMock(): PanelActions {
  return {
    toggleVisible: vi.fn(),
    setCollapsed: vi.fn(),
    setColorsExpanded: vi.fn(),
    setSplitRatios: vi.fn(),
    setRightSidebarWidth: vi.fn(),
    reset: vi.fn(),
  };
}

function withLayout(overrides: Partial<PanelLayout>): PanelLayout {
  return { ...DEFAULT_PANEL_LAYOUT, ...overrides };
}

describe("RightSidebar (UI-FTW-01, UI-FTW-08)", () => {
  beforeEach(() => {
    // A 600 px sidebar, so the splitter arithmetic runs on real heights.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 280,
      bottom: 600,
      width: 280,
      height: 600,
      toJSON: () => ({}),
    } as DOMRect);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("stacks Colors, Layers and History top to bottom with the default split", () => {
    const { container } = render(
      <RightSidebar
        layout={DEFAULT_PANEL_LAYOUT}
        actions={actionsMock()}
        width={280}
        widthResizable
        onRelinquish={() => {}}
      />,
    );
    expect(screen.getAllByRole("heading").map((heading) => heading.textContent)).toEqual([
      "Colors",
      "Layers",
      "History",
    ]);
    const panels = container.querySelectorAll<HTMLElement>(".app-panel");
    expect(panels[0]?.style.height).toBe("206px");
    expect(panels[1]?.style.height).toBe("259px");
    expect(panels[2]?.style.height).toBe("127px");
  });

  it("collapses a panel from its chevron and reports the new state", () => {
    const actions = actionsMock();
    render(
      <RightSidebar
        layout={DEFAULT_PANEL_LAYOUT}
        actions={actions}
        width={280}
        widthResizable
        onRelinquish={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse Layers" }));
    expect(actions.setCollapsed).toHaveBeenCalledWith("layers", true);
  });

  it("shows a collapsed panel as its header only", () => {
    const layout = withLayout({
      collapsed: { ...DEFAULT_PANEL_LAYOUT.collapsed, history: true },
    });
    const { container } = render(
      <RightSidebar
        layout={layout}
        actions={actionsMock()}
        width={280}
        widthResizable
        onRelinquish={() => {}}
      />,
    );
    const chevron = screen.getByRole("button", { name: "Expand History" });
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
    expect(chevron.getAttribute("aria-controls")).toBeNull();
    expect(container.querySelectorAll<HTMLElement>(".app-panel")[2]?.style.height).toBe("26px");
  });

  it("removes a hidden panel and the splitter beside it", () => {
    const layout = withLayout({
      visible: { tools: true, colors: false, layers: true, history: true },
    });
    render(
      <RightSidebar
        layout={layout}
        actions={actionsMock()}
        width={280}
        widthResizable
        onRelinquish={() => {}}
      />,
    );
    expect(screen.queryByRole("heading", { name: "Colors" })).toBeNull();
    expect(screen.getAllByRole("separator")).toHaveLength(2);
  });

  it("moves a height splitter with the arrow keys and stores the new shares", () => {
    const actions = actionsMock();
    render(
      <RightSidebar
        layout={DEFAULT_PANEL_LAYOUT}
        actions={actions}
        width={280}
        widthResizable
        onRelinquish={() => {}}
      />,
    );
    const splitter = screen.getByRole("separator", {
      name: "Resize the Layers and History panels",
    });
    fireEvent.keyDown(splitter, { key: "ArrowDown" });
    const ratios = vi.mocked(actions.setSplitRatios).mock.lastCall?.[0] ?? [];
    expect(ratios).toHaveLength(3);
    expect(ratios.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10);
    expect(ratios[1]).toBeGreaterThan(233 / 514);
  });

  it("disables the splitter between a collapsed panel and the one above it", () => {
    const layout = withLayout({
      collapsed: { ...DEFAULT_PANEL_LAYOUT.collapsed, colors: true },
    });
    const actions = actionsMock();
    render(
      <RightSidebar
        layout={layout}
        actions={actions}
        width={280}
        widthResizable
        onRelinquish={() => {}}
      />,
    );
    const splitter = screen.getByRole("separator", { name: "Resize the Colors and Layers panels" });
    expect(splitter.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(splitter, { key: "ArrowDown" });
    expect(actions.setSplitRatios).not.toHaveBeenCalled();
  });

  it("steps the sidebar width with the arrow keys (UI-FTW-08)", () => {
    const actions = actionsMock();
    render(
      <RightSidebar
        layout={DEFAULT_PANEL_LAYOUT}
        actions={actions}
        width={280}
        widthResizable
        onRelinquish={() => {}}
      />,
    );
    const splitter = screen.getByRole("separator", { name: "Resize the right sidebar" });
    fireEvent.keyDown(splitter, { key: "ArrowLeft" });
    expect(actions.setRightSidebarWidth).toHaveBeenLastCalledWith(288);
    fireEvent.keyDown(splitter, { key: "ArrowRight" });
    expect(actions.setRightSidebarWidth).toHaveBeenLastCalledWith(272);
  });

  it("does not resize the sidebar below 1280 px", () => {
    const actions = actionsMock();
    render(
      <RightSidebar
        layout={DEFAULT_PANEL_LAYOUT}
        actions={actions}
        width={220}
        widthResizable={false}
        onRelinquish={() => {}}
      />,
    );
    const splitter = screen.getByRole("separator", { name: "Resize the right sidebar" });
    expect(splitter.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(splitter, { key: "ArrowLeft" });
    expect(actions.setRightSidebarWidth).not.toHaveBeenCalled();
  });
});

describe("LeftSidebar (UI-FTW-03)", () => {
  afterEach(() => {
    cleanup();
  });

  it("holds the Tools panel, which has no collapse chevron", () => {
    render(<LeftSidebar onRelinquish={() => {}} />);
    expect(screen.getByRole("heading", { name: "Tools" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /Collapse Tools/ })).toBeNull();
  });
});
