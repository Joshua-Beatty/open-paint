import { t } from "@openpaint/i18n";
import { ErrorLog, MemoryErrorLogBackend } from "@openpaint/storage";
import { describe, expect, it, vi } from "vitest";
import { installErrorHandlers } from "./global-handlers";
import { type ErrorReport, ErrorReporter } from "./reporter";

/** Lets the reporter's async work finish before the test looks at the log. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function errorEvent(fields: { error?: unknown; message?: string }): Event {
  return Object.assign(new Event("error"), fields);
}

function rejectionEvent(reason: unknown): Event {
  return Object.assign(new Event("unhandledrejection"), { reason });
}

function setup() {
  const log = new ErrorLog(new MemoryErrorLogBackend());
  const reporter = new ErrorReporter({ log, version: "1.0.0", translate: t });
  const fatal = vi.fn<(report: ErrorReport) => void>();
  reporter.onFatal(fatal);
  const target = new EventTarget();
  const remove = installErrorHandlers(target, reporter);
  return { log, target, fatal, remove };
}

describe("installErrorHandlers (SET-LIFE-01 step 5, SET-ERR-01)", () => {
  it("logs an uncaught error and makes it fatal", async () => {
    const { log, target, fatal } = setup();

    target.dispatchEvent(errorEvent({ error: new Error("crash"), message: "crash" }));
    await settle();

    expect(log.entries[0]?.title).toBe("Error: crash");
    expect(log.entries[0]?.text).toContain("Context: uncaught error");
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(fatal.mock.calls[0]?.[0].fatal).toBe(true);
  });

  it("uses the event message when no error object is attached", async () => {
    const { log, target } = setup();

    target.dispatchEvent(errorEvent({ error: null, message: "Script error." }));
    await settle();

    expect(log.entries[0]?.title).toBe("Script error.");
  });

  it("ignores the browser's ResizeObserver loop notice, which is not a bug", async () => {
    const { log, target, fatal } = setup();

    target.dispatchEvent(
      errorEvent({
        error: null,
        message: "ResizeObserver loop completed with undelivered notifications.",
      }),
    );
    await settle();

    expect(log.entries).toEqual([]);
    expect(fatal).not.toHaveBeenCalled();
  });

  it("names an event with neither an error nor a message as unknown", async () => {
    const { log, target } = setup();

    target.dispatchEvent(errorEvent({ error: undefined, message: "" }));
    await settle();

    expect(log.entries[0]?.title).toBe("Unknown error");
  });

  it("logs an unhandled rejection without showing the fatal dialog", async () => {
    const { log, target, fatal } = setup();

    target.dispatchEvent(rejectionEvent(new Error("late")));
    await settle();

    expect(log.entries[0]?.text).toContain("Context: unhandled promise rejection");
    expect(fatal).not.toHaveBeenCalled();
  });

  it("stops handling events after it is removed", async () => {
    const { log, target, fatal, remove } = setup();
    remove();

    target.dispatchEvent(errorEvent({ error: new Error("ignored") }));
    target.dispatchEvent(rejectionEvent("ignored"));
    await settle();

    expect(log.entries).toEqual([]);
    expect(fatal).not.toHaveBeenCalled();
  });
});
