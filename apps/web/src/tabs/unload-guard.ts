/**
 * Asks the browser to confirm before the tab or window closes or reloads while `hasUnsaved()` is
 * true (WEB-UI-06, SET-LIFE-05). The browser shows its own generic text, so no message is set.
 * Returns the function that removes the guard.
 */
export function guardUnload(target: Window, hasUnsaved: () => boolean): () => void {
  const onBeforeUnload = (event: Event) => {
    if (!hasUnsaved()) return;
    event.preventDefault();
    (event as BeforeUnloadEvent).returnValue = "";
  };
  target.addEventListener("beforeunload", onBeforeUnload);
  return () => {
    target.removeEventListener("beforeunload", onBeforeUnload);
  };
}
