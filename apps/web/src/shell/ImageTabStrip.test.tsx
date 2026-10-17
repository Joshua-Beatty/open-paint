import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILT_IN_REGISTRY } from "../commands/catalog";
import { platformFromName } from "../commands/keys";
import { ShortcutController } from "../commands/shortcuts";
import type { ImageTabView } from "./ImageTabStrip";
import { ImageTabStrip } from "./ImageTabStrip";

const TABS: ImageTabView[] = [
  { id: "tab-1", title: "A", dirty: false, busy: false, thumbnail: undefined },
  { id: "tab-2", title: "B", dirty: true, busy: false, thumbnail: undefined },
  { id: "tab-3", title: "C", dirty: false, busy: true, thumbnail: "data:image/png;base64,AAAA" },
];

function renderStrip(tabs: readonly ImageTabView[] = TABS, activeId: string | undefined = "tab-2") {
  const commands = new ShortcutController(BUILT_IN_REGISTRY, platformFromName("Win32"));
  const onActivate = vi.fn();
  const onClose = vi.fn();
  const onMove = vi.fn();
  render(
    <ImageTabStrip
      tabs={tabs}
      activeId={activeId}
      commands={commands}
      onActivate={onActivate}
      onClose={onClose}
      onMove={onMove}
    />,
  );
  return { commands, onActivate, onClose, onMove };
}

describe("ImageTabStrip", () => {
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

  it("lists the images as tabs, marks the active one, and names unsaved ones", () => {
    renderStrip();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual([
      "A",
      "B (unsaved changes)",
      "C",
    ]);
    expect(
      screen.getByRole("tab", { name: "B (unsaved changes)" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("tab", { name: "A" }).getAttribute("aria-selected")).toBe("false");
  });

  it("gives each thumbnail box its image's aspect ratio (UI-TABS-01)", () => {
    renderStrip([
      { ...TABS[0], id: "tall", title: "Tall", size: { width: 300, height: 600 } } as ImageTabView,
      { ...TABS[0], id: "any", title: "Any" } as ImageTabView,
    ]);
    const box = (name: string) =>
      screen.getByRole("tab", { name }).querySelector<HTMLElement>(".app-image-tab-thumb-image");
    expect(box("Tall")?.style.width).toBe("13px");
    expect(box("Tall")?.style.height).toBe("26px");
    expect(box("Any")?.style.width).toBe("40px");
  });

  it("does not render again when a re-measure finds the same scroll edges (L3)", () => {
    const commits = vi.fn();
    const commands = new ShortcutController(BUILT_IN_REGISTRY, platformFromName("Win32"));
    render(
      <Profiler id="strip" onRender={commits}>
        <ImageTabStrip
          tabs={TABS}
          activeId="tab-2"
          commands={commands}
          onActivate={vi.fn()}
          onClose={vi.fn()}
          onMove={vi.fn()}
        />
      </Profiler>,
    );
    const before = commits.mock.calls.length;
    act(() => {
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
    });
    expect(commits.mock.calls.length).toBe(before);
  });

  it("keeps the active tab in the tab order and takes the others out of it", () => {
    renderStrip();
    expect(screen.getByRole("tab", { name: "B (unsaved changes)" }).tabIndex).toBe(0);
    expect(screen.getByRole("tab", { name: "A" }).tabIndex).toBe(-1);
  });

  it("shows a pointer-only close button on every tab, out of the tab order and the accessibility tree", () => {
    renderStrip();
    const closes = document.querySelectorAll<HTMLButtonElement>(".app-image-tab-close");
    expect(closes).toHaveLength(TABS.length);
    for (const close of closes) {
      expect(close.getAttribute("aria-hidden")).toBe("true");
      expect(close.tabIndex).toBe(-1);
    }
  });

  it("shows the thumbnail once it is drawn", () => {
    const { container } = render(
      <ImageTabStrip
        tabs={TABS}
        activeId="tab-2"
        commands={new ShortcutController(BUILT_IN_REGISTRY, "other")}
        onActivate={() => {}}
        onClose={() => {}}
        onMove={() => {}}
      />,
    );
    const images = container.querySelectorAll("img");
    expect([...images].map((img) => img.getAttribute("src"))).toEqual([
      "data:image/png;base64,AAAA",
    ]);
  });

  it("selects a tab on click and closes it from its close button", () => {
    const { onActivate, onClose } = renderStrip();
    fireEvent.click(screen.getByRole("tab", { name: "A" }));
    expect(onActivate).toHaveBeenLastCalledWith("tab-1");
    fireEvent.click(
      document.querySelectorAll<HTMLElement>(".app-image-tab-close")[0] as HTMLElement,
    );
    expect(onClose).toHaveBeenLastCalledWith("tab-1");
  });

  it("closes a tab on a middle click", () => {
    const { onClose } = renderStrip();
    fireEvent(
      screen.getByRole("tab", { name: "C" }),
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );
    expect(onClose).toHaveBeenLastCalledWith("tab-3");
  });

  it("moves the selection with the arrow and Home and End keys", () => {
    const { onActivate } = renderStrip();
    fireEvent.keyDown(screen.getByRole("tab", { name: "B (unsaved changes)" }), {
      key: "ArrowRight",
    });
    expect(onActivate).toHaveBeenLastCalledWith("tab-3");
    fireEvent.keyDown(screen.getByRole("tab", { name: "B (unsaved changes)" }), { key: "Home" });
    expect(onActivate).toHaveBeenLastCalledWith("tab-1");
    fireEvent.keyDown(screen.getByRole("tab", { name: "B (unsaved changes)" }), { key: "End" });
    expect(onActivate).toHaveBeenLastCalledWith("tab-3");
  });

  it("opens the tab menu on right-click with the file name as its title", async () => {
    renderStrip();
    fireEvent.contextMenu(screen.getByRole("tab", { name: "A" }), { clientX: 10, clientY: 20 });
    const menu = await screen.findByRole("menu", { name: "A" });
    expect(
      within(menu)
        .getByRole("menuitem", { name: /^Copy File/ })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      within(menu).getByRole("menuitem", { name: "SaveCtrl+S" }).getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("activates the tab and runs Close on it from its menu", async () => {
    const { commands, onActivate } = renderStrip();
    const ran: string[] = [];
    commands.register("file.close", { run: () => ran.push("close") });
    fireEvent.contextMenu(screen.getByRole("tab", { name: "A" }), { clientX: 10, clientY: 20 });
    const menu = await screen.findByRole("menu", { name: "A" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "CloseCtrl+W" }));
    expect(onActivate).toHaveBeenLastCalledWith("tab-1");
    expect(ran).toEqual(["close"]);
  });

  it("opens the active tab's menu with Alt+-", async () => {
    const { commands } = renderStrip();
    act(() => {
      commands.handleKeyDown(
        {
          code: "Minus",
          altKey: true,
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
          preventDefault() {},
        },
        { editing: false },
      );
    });
    expect(await screen.findByRole("menu", { name: "B" })).toBeDefined();
  });

  it("hides the scroll arrows while every tab fits", () => {
    renderStrip();
    expect(screen.queryByRole("button", { name: "Scroll tabs left" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Scroll tabs right" })).toBeNull();
  });

  it("disables the image list when there are no images", () => {
    renderStrip([], undefined);
    expect(screen.getByRole("button", { name: "Image list" }).hasAttribute("disabled")).toBe(true);
  });
});
