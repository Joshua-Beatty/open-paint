import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FileDialogHost } from "./FileDialogs";
import { FileDialogs } from "./file-dialogs";

describe("FileDialogHost", () => {
  afterEach(() => {
    cleanup();
  });

  it("draws nothing until a dialog is requested", () => {
    render(<FileDialogHost dialogs={new FileDialogs()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers Retry, Skip and Cancel after a failed transfer, with the error text", async () => {
    const dialogs = new FileDialogs();
    render(<FileDialogHost dialogs={dialogs} />);
    const answer = dialogs.transferError("There was an error transferring the image:\n\nbad");

    const dialog = await screen.findByRole("dialog", { name: "Transfer Error" });
    expect(dialog.textContent).toContain("bad");
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    expect(await answer).toBe("skip");
    expect(dialogs.request).toBeUndefined();
  });

  it("asks Flatten or Cancel before a multi-layer save", async () => {
    const dialogs = new FileDialogs();
    render(<FileDialogHost dialogs={dialogs} />);
    const answer = dialogs.flatten();

    await screen.findByRole("dialog", { name: "Save" });
    fireEvent.click(screen.getByRole("button", { name: "Flatten" }));

    expect(await answer).toBe(true);
  });

  it("answers the download save dialog with the name and type", async () => {
    const dialogs = new FileDialogs();
    render(<FileDialogHost dialogs={dialogs} />);
    const answer = dialogs.saveName(
      "Untitled.png",
      [{ id: "png", label: "PNG", extensions: [".png"] }],
      "png",
    );

    const dialog = await screen.findByRole("dialog", { name: "Save" });
    expect(dialog.textContent).not.toContain("downloads");
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "sketch" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await answer).toEqual({ name: "sketch", typeId: "png" });
  });

  it("keeps the name's extension and the Type list in step (owner request)", async () => {
    const dialogs = new FileDialogs();
    render(<FileDialogHost dialogs={dialogs} />);
    const types = [
      { id: "png", label: "PNG", extensions: [".png"] },
      { id: "openpaint", label: "OpenPaint", extensions: [".openpaint"] },
      { id: "jpeg", label: "JPEG", extensions: [".jpg", ".jpeg"] },
    ];
    const answer = dialogs.saveName("Untitled.png", types, "png");
    await screen.findByRole("dialog", { name: "Save" });
    const name = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    const type = screen.getByRole("combobox", { name: "Type" }) as HTMLSelectElement;

    // Choosing a type swaps the extension in the name.
    fireEvent.change(type, { target: { value: "openpaint" } });
    expect(name.value).toBe("Untitled.openpaint");
    // Typing a known extension picks its type; any of a type's extensions stays as typed.
    fireEvent.change(name, { target: { value: "Untitled.jpeg" } });
    expect(type.value).toBe("jpeg");
    fireEvent.change(type, { target: { value: "jpeg" } });
    expect(name.value).toBe("Untitled.jpeg");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await answer).toEqual({ name: "Untitled.jpeg", typeId: "jpeg" });
  });

  it("asks Open or Add layers for dropped files, with the new-image explanation when no image is open", async () => {
    const dialogs = new FileDialogs();
    render(<FileDialogHost dialogs={dialogs} />);
    const answer = dialogs.dropChoice(2, false);

    const dialog = await screen.findByRole("dialog", { name: "Drag and Drop" });
    expect(dialog.textContent).toContain("What would you like to do with the files?");
    expect(dialog.textContent).toContain("in a new image.");
    fireEvent.click(screen.getByRole("button", { name: "Add layers" }));

    expect(await answer).toBe("addLayers");
    expect(dialogs.request).toBeUndefined();
  });

  it("resolves a dropped file's question to Open, and to nothing on Cancel", async () => {
    const dialogs = new FileDialogs();
    render(<FileDialogHost dialogs={dialogs} />);
    const answer = dialogs.dropChoice(1, true);

    await screen.findByRole("dialog", { name: "Drag and Drop" });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await answer).toBe("open");

    const canceled = dialogs.dropChoice(1, true);
    await screen.findByRole("dialog", { name: "Drag and Drop" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await canceled).toBeUndefined();
  });

  it("offers the paste prompt's choices for an imported image larger than the canvas", async () => {
    const dialogs = new FileDialogs();
    render(<FileDialogHost dialogs={dialogs} />);
    const answer = dialogs.importSize();

    await screen.findByRole("dialog", { name: "Import From File" });
    fireEvent.click(screen.getByRole("button", { name: "Keep canvas size" }));

    expect(await answer).toBe("keep");
  });

  it("prints fit to the page by default, or at actual size when chosen (FMT-PRN-01)", async () => {
    const dialogs = new FileDialogs();
    render(<FileDialogHost dialogs={dialogs} />);
    const answer = dialogs.printChoice();

    await screen.findByRole("dialog", { name: "Print" });
    expect(screen.getByRole("radio", { name: "Fit to page" })).toHaveProperty("checked", true);
    fireEvent.click(screen.getByRole("radio", { name: "Actual size" }));
    fireEvent.click(screen.getByRole("button", { name: "Print" }));

    expect(await answer).toBe("actual");
    expect(dialogs.request).toBeUndefined();
  });

  it("prints nothing when the print dialog is canceled", async () => {
    const dialogs = new FileDialogs();
    render(<FileDialogHost dialogs={dialogs} />);
    const answer = dialogs.printChoice();

    await screen.findByRole("dialog", { name: "Print" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(await answer).toBeUndefined();
  });

  it("shows the transfer progress with its file count", async () => {
    const dialogs = new FileDialogs();
    render(<FileDialogHost dialogs={dialogs} />);
    act(() => {
      dialogs.show({ kind: "transfer", index: 2, total: 3, canceling: false, cancel: () => {} });
    });

    expect(await screen.findByText("2 of 3")).toBeDefined();
  });
});
