import { t } from "@openpaint/i18n";
import { ErrorLog, MemoryErrorLogBackend } from "@openpaint/storage";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorReporter } from "../errors/reporter";
import { ErrorLogSection } from "./ErrorLogSection";

function makeReporter() {
  const log = new ErrorLog(new MemoryErrorLogBackend());
  return new ErrorReporter({ log, version: "1.0.0", translate: t });
}

async function record(reporter: ErrorReporter, message: string): Promise<void> {
  await reporter.report(new Error(message));
}

function selectedText(): string {
  const text = document.querySelector<HTMLElement>(".settings-error-text");
  if (text === null) throw new Error("The error text is not shown.");
  return text.textContent ?? "";
}

describe("ErrorLogSection (SET-DLG-12)", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("says the log is empty and disables the buttons that need entries", () => {
    render(<ErrorLogSection errors={makeReporter()} />);

    expect(screen.getByText("The error log is empty.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy error log" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "Clear error log" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("lists entries newest first and shows the selected entry's full text", async () => {
    const reporter = makeReporter();
    await record(reporter, "first");
    await record(reporter, "second");
    render(<ErrorLogSection errors={reporter} />);
    await act(async () => undefined);

    const items = within(
      document.querySelector(".settings-error-list") as HTMLElement,
    ).getAllByRole("button");
    expect(items[0]?.textContent).toContain("Error: second");
    expect(selectedText()).toBe("Select an entry to read its full text.");

    fireEvent.click(items[1] as HTMLElement);

    expect(selectedText()).toContain("Message: Error: first");
    expect(selectedText()).toBe(reporter.log.entries[1]?.text);
  });

  it("copies the selected entry, or every entry when none is selected", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const reporter = makeReporter();
    await record(reporter, "first");
    await record(reporter, "second");
    render(<ErrorLogSection errors={reporter} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy error log" }));
    await act(async () => undefined);
    expect(writeText).toHaveBeenLastCalledWith(
      reporter.log.entries.map((entry) => entry.text).join("\n\n"),
    );

    const list = document.querySelector(".settings-error-list") as HTMLElement;
    fireEvent.click(within(list).getAllByRole("button")[0] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Copy error log" }));
    await act(async () => undefined);
    expect(writeText).toHaveBeenLastCalledWith(reporter.log.entries[0]?.text);
  });

  it("clears the log only after confirmation", async () => {
    const reporter = makeReporter();
    await record(reporter, "first");
    render(<ErrorLogSection errors={reporter} />);

    fireEvent.click(screen.getByRole("button", { name: "Clear error log" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(reporter.log.entries).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Clear error log" }));
    fireEvent.click(await screen.findByRole("button", { name: "Clear" }));

    expect(reporter.log.entries).toEqual([]);
    expect(screen.getByText("The error log is empty.")).toBeTruthy();
  });
});
