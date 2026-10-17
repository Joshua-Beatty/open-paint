import { t } from "@openpaint/i18n";
import {
  ErrorLog,
  MemoryErrorLogBackend,
  MemorySettingsBackend,
  SettingsStore,
} from "@openpaint/storage";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorReporter } from "../errors/reporter";
import type { OpenSourceComponent } from "../help/open-source";
import { PenInputTracker } from "./pen-input";
import { SettingsDialog } from "./SettingsDialog";
import type { SettingsSection } from "./settings-pages";

function renderDialog(
  store: SettingsStore | null,
  section: SettingsSection,
  onClose = vi.fn(),
  loadComponents?: () => Promise<readonly OpenSourceComponent[]>,
) {
  const errors = new ErrorReporter({
    log: new ErrorLog(new MemoryErrorLogBackend()),
    version: "0.0.0",
    translate: t,
  });
  return render(
    <SettingsDialog
      isOpen
      section={section}
      settings={store}
      engine={undefined}
      status={undefined}
      pen={new PenInputTracker()}
      version="0.0.0"
      sessionStart={new Date()}
      errors={errors}
      loadComponents={loadComponents}
      onClose={onClose}
    />,
  );
}

function sectionList(): HTMLElement {
  const list = document.querySelector<HTMLElement>(".settings-sections");
  if (list === null) throw new Error("The section list is not shown.");
  return list;
}

describe("SettingsDialog", () => {
  let store: SettingsStore;

  beforeEach(async () => {
    store = await SettingsStore.open({
      backend: new MemorySettingsBackend(),
      channel: null,
      mirror: null,
      lifecycle: null,
      flushDelayMs: 60_000,
    });
  });

  afterEach(async () => {
    cleanup();
    await store.dispose();
  });

  it("lists the six v1 sections in order, then the open-source licenses", () => {
    renderDialog(store, "ui");
    const names = within(sectionList())
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(names).toEqual([
      "User Interface",
      "Canvas",
      "Tools",
      "Pen & Tablet",
      "Graphics",
      "Diagnostics",
      "Open-Source Licenses",
    ]);
  });

  it("lists the bundled fonts, icons and libraries with their licenses on the Licenses page", async () => {
    const components: readonly OpenSourceComponent[] = [
      {
        name: "@fontsource/pacifico",
        title: "Pacifico",
        kind: "font",
        version: "5.3.0",
        license: "OFL-1.1",
        url: "https://github.com/fontsource/font-files",
        copyright: "Copyright 2018 The Pacifico Project Authors",
        licenseText: "SIL OPEN FONT LICENSE Version 1.1",
      },
      {
        name: "remixicon",
        title: "Remix Icon",
        kind: "icons",
        version: "4.9.1",
        license: "Remix Icon License v1.0",
        url: "",
        copyright: "Copyright (c) 2017-2026 Remix Design",
        licenseText: "Remix Icon License v1.0",
      },
      {
        name: "react",
        title: "react",
        kind: "library",
        version: "19.3.0",
        license: "MIT",
        url: "",
        copyright: "",
        licenseText: "",
      },
    ];
    renderDialog(store, "licenses", vi.fn(), () => Promise.resolve(components));
    const fonts = await screen.findByRole("region", { name: "Fonts" });
    expect(screen.getByRole("region", { name: "Icons" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Libraries" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /THIRD-PARTY-NOTICES\.txt/ }).getAttribute("href"),
    ).toBe("/THIRD-PARTY-NOTICES.txt");
    const font = within(fonts).getByRole("button", { name: /Pacifico 5\.3\.0/ });
    expect(font.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(font);
    expect(font.getAttribute("aria-expanded")).toBe("true");
    const detail = screen.getByRole("region", { name: "@fontsource/pacifico@5.3.0" });
    expect(within(detail).getByText("Package: @fontsource/pacifico")).toBeTruthy();
    expect(within(detail).getByText("License: OFL-1.1")).toBeTruthy();
    expect(within(detail).getByText("Copyright 2018 The Pacifico Project Authors")).toBeTruthy();
    expect(within(detail).getByText("SIL OPEN FONT LICENSE Version 1.1")).toBeTruthy();
  });

  it("writes a checkbox straight to the live setting", () => {
    renderDialog(store, "canvas");
    const shadow = screen.getByRole("checkbox", { name: "Draw a shadow around the canvas" });
    expect((shadow as HTMLInputElement).checked).toBe(true);
    fireEvent.click(shadow);
    expect(store.get("canvas.dropShadow")).toBe(false);
  });

  it("shows a setting that changes elsewhere, such as another tab", () => {
    renderDialog(store, "canvas");
    const shadow = screen.getByRole("checkbox", {
      name: "Draw a shadow around the canvas",
    }) as HTMLInputElement;
    expect(shadow.checked).toBe(true);
    act(() => store.set("canvas.dropShadow", false));
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Draw a shadow around the canvas",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
  });

  it("resets the panel layout from the User Interface page", () => {
    renderDialog(store, "ui");
    store.set("layout.rightSidebar.width", 320);
    fireEvent.click(screen.getByRole("button", { name: "Reset panel layout" }));
    expect(store.get("layout.rightSidebar.width")).toBe(280);
  });

  it("resets every setting after confirmation", () => {
    renderDialog(store, "ui");
    store.set("ui.animations", false);
    fireEvent.click(screen.getByRole("button", { name: "Reset all settings..." }));
    expect(store.get("ui.animations")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Reset all settings" }));
    expect(store.get("ui.animations")).toBe(true);
  });

  it("closes from the title bar's close button, which replaces the bottom Close button", () => {
    const onClose = vi.fn();
    renderDialog(store, "ui", onClose);
    const [close, ...others] = screen.getAllByRole("button", { name: "Close" });
    expect(others).toHaveLength(0);
    if (close === undefined) throw new Error("no close button");
    expect(close.closest(".modal-header")).not.toBeNull();
    expect(document.querySelector(".settings-dialog .modal-actions")).toBeNull();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("notes that no pen has been seen on the Pen & Tablet page", () => {
    renderDialog(store, "pen");
    expect(screen.getByText("No pen input has been detected yet.")).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: "Pen pressure and high-frequency input" }),
    ).toBeTruthy();
  });

  it("shows the Diagnostics report once it has been gathered", async () => {
    renderDialog(store, "diagnostics");
    expect(await screen.findByText("Application")).toBeTruthy();
    expect(screen.getAllByText("Browser").length).toBeGreaterThan(0);
  });

  it("does not render while the settings are still opening", () => {
    renderDialog(null, "ui");
    expect(document.querySelector(".settings-dialog")).toBeNull();
  });
});
