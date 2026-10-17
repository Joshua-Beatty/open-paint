import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AboutDialog, type AboutDialogProps } from "./AboutDialog";
import type { OpenSourceComponent } from "./open-source";
import { UpdateController, type UpdateHost } from "./updates";

const components: readonly OpenSourceComponent[] = [
  {
    name: "react",
    title: "react",
    kind: "library",
    version: "19.3.0",
    license: "MIT",
    url: "https://github.com/facebook/react",
    copyright: "Copyright (c) Meta Platforms, Inc. and affiliates.",
    licenseText: "MIT License text for React",
  },
  {
    name: "tiny",
    title: "tiny",
    kind: "library",
    version: "1.0.0",
    license: "ISC",
    url: "",
    copyright: "",
    licenseText: "",
  },
  {
    name: "@fontsource/caveat",
    title: "Caveat",
    kind: "font",
    version: "5.3.0",
    license: "OFL-1.1",
    url: "",
    copyright: "Copyright 2014 The Caveat Project Authors",
    licenseText: "OFL text",
  },
  {
    name: "libwebp",
    title: "libwebp",
    kind: "codec",
    version: "1.1.0",
    license: "BSD-3-Clause",
    url: "https://github.com/webmproject/libwebp",
    copyright: "Copyright (c) 2010, Google Inc. All rights reserved.",
    licenseText: "BSD text",
  },
  {
    name: "rav1e",
    title: "rav1e",
    kind: "rust",
    version: "0.8.1",
    license: "BSD-2-Clause",
    url: "https://github.com/xiph/rav1e/",
    copyright: "Copyright (c) 2017-2023, the rav1e contributors",
    licenseText: "BSD 2-Clause text",
  },
];

function renderAbout(overrides: Partial<AboutDialogProps> = {}) {
  const host: UpdateHost = {
    check: vi.fn(() => Promise.resolve(false)),
    activate: vi.fn(),
  };
  const props: AboutDialogProps = {
    isOpen: true,
    version: "1.2.3",
    buildDate: "2026-10-13T12:00:00.000Z",
    loadComponents: vi.fn(() => Promise.resolve(components)),
    updates: new UpdateController(host, { isOnline: () => true }),
    onReload: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<AboutDialog {...props} />);
  return props;
}

describe("AboutDialog (SET-HELP-02)", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows the name, version, build date and the MIT license line", async () => {
    renderAbout();
    const dialog = screen.getByRole("dialog", { name: "About OpenPaint" });
    expect(within(dialog).getByText("OpenPaint")).toBeDefined();
    expect(within(dialog).getByText("version 1.2.3")).toBeDefined();
    expect(within(dialog).getByText("Build date: October 13, 2026")).toBeDefined();
    expect(
      within(dialog).getByText(
        "Copyright © 2026 OpenPaint contributors. OpenPaint is released under the MIT License.",
      ),
    ).toBeDefined();
    expect(within(dialog).getByText("OpenPaint contributors")).toBeDefined();
    await within(dialog).findByRole("button", { name: /react 19\.3\.0/ });
  });

  it("lists every bundled component from the loader, fonts first, by name", async () => {
    renderAbout();
    expect(await screen.findByRole("button", { name: /react 19\.3\.0/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /tiny 1\.0\.0/ })).toBeDefined();
    const fonts = screen.getByRole("region", { name: "Fonts" });
    expect(within(fonts).getByRole("button", { name: /Caveat 5\.3\.0/ })).toBeDefined();
    expect(screen.getByRole("link", { name: /THIRD-PARTY-NOTICES\.txt/ })).toBeDefined();
  });

  it("groups the libraries in the codecs' and OpenPaint's WebAssembly apart from the others", async () => {
    renderAbout();
    await screen.findByRole("button", { name: /react 19\.3\.0/ });
    const headings = screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent);
    expect(headings).toEqual(["Fonts", "Libraries", "Codec libraries", "Rust libraries"]);
    const codecs = screen.getByRole("region", { name: "Codec libraries" });
    expect(within(codecs).getByRole("button", { name: /libwebp 1\.1\.0/ })).toBeDefined();
    const crates = screen.getByRole("region", { name: "Rust libraries" });
    expect(within(crates).getByRole("button", { name: /rav1e 0\.8\.1/ })).toBeDefined();
  });

  it("shows a component's copyright, full license text and project link when it is selected", async () => {
    renderAbout();
    fireEvent.click(await screen.findByRole("button", { name: /react 19\.3\.0/ }));
    const detail = screen.getByRole("region", { name: "react@19.3.0" });
    expect(within(detail).getByText("MIT License text for React")).toBeDefined();
    expect(
      within(detail).getByText("Copyright (c) Meta Platforms, Inc. and affiliates."),
    ).toBeDefined();
    const link = within(detail).getByRole("link", { name: "https://github.com/facebook/react" });
    expect(link.getAttribute("href")).toBe("https://github.com/facebook/react");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("says when a component has no license text, and collapses on a second press", async () => {
    renderAbout();
    const tiny = await screen.findByRole("button", { name: /tiny 1\.0\.0/ });
    fireEvent.click(tiny);
    expect(
      screen
        .getByRole("region", { name: "tiny@1.0.0" })
        .textContent?.includes("The license text for this package was not found."),
    ).toBe(true);
    fireEvent.click(tiny);
    expect(screen.queryByRole("region", { name: "tiny@1.0.0" })).toBeNull();
  });

  it("checks for updates inline from the About dialog (SET-DLG-09)", async () => {
    renderAbout();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("OpenPaint is up to date.")).toBeDefined();
  });

  it("closes through the title bar's close button, its only Close, and Esc, with focus in the dialog", async () => {
    const props = renderAbout();
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.closest(".modal-header")).not.toBeNull();
    expect(dialog.querySelector(".modal-actions")).toBeNull();
    fireEvent.click(close);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it("is not in the page, and loads nothing, while closed", () => {
    const props = renderAbout({ isOpen: false });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(props.loadComponents).not.toHaveBeenCalled();
  });

  it("loads the list each time it opens", async () => {
    const loadComponents = vi.fn(() => Promise.resolve(components));
    const { rerender } = render(<AboutDialogHarness loadComponents={loadComponents} open />);
    await screen.findByRole("button", { name: /react 19\.3\.0/ });
    rerender(<AboutDialogHarness loadComponents={loadComponents} open={false} />);
    await act(async () => {});
    rerender(<AboutDialogHarness loadComponents={loadComponents} open />);
    await screen.findByRole("button", { name: /react 19\.3\.0/ });
    expect(loadComponents).toHaveBeenCalledTimes(2);
  });
});

function AboutDialogHarness({
  open,
  loadComponents,
}: {
  readonly open: boolean;
  readonly loadComponents: () => Promise<readonly OpenSourceComponent[]>;
}) {
  const updates = new UpdateController(
    { check: () => Promise.resolve(false), activate: () => {} },
    { isOnline: () => true },
  );
  return (
    <AboutDialog
      isOpen={open}
      version="1.2.3"
      buildDate="2026-10-13T12:00:00.000Z"
      loadComponents={loadComponents}
      updates={updates}
      onReload={() => {}}
      onClose={() => {}}
    />
  );
}
