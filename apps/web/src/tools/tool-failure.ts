import { OutOfMemoryError } from "@openpaint/document";
import type { PaintHost } from "./paint-tools";

/**
 * Tells the user that a tool's edit failed and was canceled. A refused memory operation gets its own
 * message (WEB-MEM-03). Any other failure goes to the error log, and the user is told where to look
 * (SET-ERR-01), so a failed edit never disappears silently.
 */
export function reportToolFailure(
  host: Pick<PaintHost, "notify" | "report">,
  cause: unknown,
): void {
  if (cause instanceof OutOfMemoryError) {
    host.notify("edit.outOfMemory");
    return;
  }
  host.report(cause);
  host.notify("edit.toolFailed");
}
