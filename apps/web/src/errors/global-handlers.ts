import type { ErrorReporter } from "./reporter";

/** Browsers report this layout notice as an uncaught error. It is not a bug, so it is not logged. */
const RESIZE_OBSERVER_NOTICE = /^ResizeObserver loop/;

/**
 * Installs the global error handlers (SET-LIFE-01 step 5). An uncaught error leaves the app in an
 * unknown state, so it is fatal and shows the OpenPaint Error dialog. An unhandled promise
 * rejection is logged only, since the code that owns the promise may recover. Returns the function
 * that removes the handlers.
 */
export function installErrorHandlers(target: EventTarget, reporter: ErrorReporter): () => void {
  const onError = (event: Event) => {
    const { error, message } = event as ErrorEvent;
    if (RESIZE_OBSERVER_NOTICE.test(message)) return;
    const cause = error ?? (message === "" ? "Unknown error" : message);
    logged(reporter.report(cause, { fatal: true, context: "uncaught error" }));
  };
  const onRejection = (event: Event) => {
    const { reason } = event as Event & { readonly reason?: unknown };
    logged(reporter.report(reason, { context: "unhandled promise rejection" }));
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

/** The handlers must not throw, so a failure to log is dropped rather than reported again. */
function logged(pending: Promise<unknown>): void {
  pending.catch(() => undefined);
}
