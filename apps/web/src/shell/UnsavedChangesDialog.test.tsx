import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog";

const sketch = { id: "tab-1", name: "Sketch", thumbnail: "sketch.png" };
const poster = { id: "tab-2", name: "Poster" };

/** Renders the dialog. Save is wired only when `withSave` is set, as it is once a save flow exists. */
function renderDialog(images: readonly (typeof sketch | typeof poster)[], withSave = false) {
  const handlers = {
    onSave: vi.fn(),
    onDiscard: vi.fn(),
    onCancel: vi.fn(),
    onActivate: vi.fn(),
  };
  render(
    <UnsavedChangesDialog
      images={images}
      onSave={withSave ? handlers.onSave : undefined}
      onDiscard={handlers.onDiscard}
      onCancel={handlers.onCancel}
      onActivate={handlers.onActivate}
    />,
  );
  return handlers;
}

describe("UnsavedChangesDialog", () => {
  afterEach(() => {
    cleanup();
  });

  it("names the single dirty image and offers Save, Don't Save and Cancel (UI-DOC-03)", () => {
    renderDialog([sketch], true);
    const dialog = screen.getByRole("dialog", { name: "Unsaved Changes" });
    expect(
      within(dialog).getByText("Sketch has unsaved changes. What would you like to do?"),
    ).toBeDefined();
    expect(within(dialog).queryByRole("list")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "Don't Save" })).toBeDefined();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDefined();
  });

  it("disables Save until a save flow exists", () => {
    renderDialog([sketch]);
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("runs Save and Don't Save through their handlers", () => {
    const handlers = renderDialog([sketch], true);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Don't Save" }));
    expect(handlers.onDiscard).toHaveBeenCalledTimes(1);
  });

  it("calls Save and not Discard when the save handler is present", () => {
    const handlers = renderDialog([sketch], true);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(handlers.onSave).toHaveBeenCalledTimes(1);
    expect(handlers.onDiscard).not.toHaveBeenCalled();
  });

  it("leaves the images open on Cancel and on Esc (UI-DOC-03)", () => {
    const handlers = renderDialog([sketch]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(handlers.onCancel).toHaveBeenCalledTimes(2);
    expect(handlers.onDiscard).not.toHaveBeenCalled();
  });

  it("lists several dirty images as thumbnails and activates one when clicked (UI-DOC-04)", () => {
    const handlers = renderDialog([sketch, poster]);
    const dialog = screen.getByRole("dialog", { name: "Unsaved Changes" });
    expect(
      within(dialog).getByText(
        "The following images that are open have changes that have not been saved. You may click on a thumbnail to show the image in the main view.",
      ),
    ).toBeDefined();
    expect(within(dialog).getByRole("heading", { name: "Images" })).toBeDefined();
    const list = within(dialog).getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole("button", { name: "Poster" }));
    expect(handlers.onActivate).toHaveBeenCalledWith("tab-2");
    expect(handlers.onDiscard).not.toHaveBeenCalled();
  });

  it("shows the thumbnail of each image that has one", () => {
    renderDialog([sketch, poster]);
    const thumbnail = screen.getByRole("button", { name: "Sketch" }).querySelector("img");
    expect(thumbnail?.getAttribute("src")).toBe("sketch.png");
    expect(screen.getByRole("button", { name: "Poster" }).querySelector("img")).toBeNull();
  });

  it("discards every listed image through Don't Save", () => {
    const handlers = renderDialog([sketch, poster]);
    fireEvent.click(screen.getByRole("button", { name: "Don't Save" }));
    expect(handlers.onDiscard).toHaveBeenCalledTimes(1);
  });
});
