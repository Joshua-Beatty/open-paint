import type { MessageId } from "@openpaint/i18n";
import { useTranslation } from "@openpaint/i18n/react";
import { useSyncExternalStore } from "react";
import { Button } from "react-aria-components";
import type { UpdateController, UpdateState } from "./updates";

export interface UpdateNoticeProps {
  readonly updates: UpdateController;
  readonly onReload: () => void;
}

/**
 * The non-blocking "Update available" notice (WEB-UPD-01, SET-UPD-04). "Reload now" goes through
 * the app's unsaved-work check, so the notice never reloads on its own.
 */
export function UpdateNotice({ updates, onReload }: UpdateNoticeProps) {
  const t = useTranslation();
  const { noticeVisible } = useSyncExternalStore(updates.subscribe, () => updates.snapshot);
  if (!noticeVisible) return null;
  return (
    <section className="app-notice app-update-notice" aria-label={t("update.notice")}>
      <p>{t("update.notice")}</p>
      <div className="app-update-actions">
        <Button onPress={onReload}>{t("update.reloadNow")}</Button>
        <Button onPress={() => updates.dismissNotice()}>{t("update.later")}</Button>
      </div>
    </section>
  );
}

export interface UpdateCheckProps {
  readonly updates: UpdateController;
  /** Reloads onto the waiting version. Without it, the result has no Reload button. */
  readonly onReload?: (() => void) | undefined;
}

/** The "Check for updates" button and its inline result (SET-DLG-09, SET-UPD-04). */
export function UpdateCheck({ updates, onReload }: UpdateCheckProps) {
  const t = useTranslation();
  const { state } = useSyncExternalStore(updates.subscribe, () => updates.snapshot);
  const message = statusMessage(state);
  return (
    <div className="help-update-check">
      <Button isDisabled={state === "checking"} onPress={() => void updates.checkNow()}>
        {t("update.check")}
      </Button>
      {message !== undefined && <p aria-live="polite">{t(message)}</p>}
      {state === "updateAvailable" && onReload !== undefined && (
        <Button onPress={onReload}>{t("update.reload")}</Button>
      )}
    </div>
  );
}

function statusMessage(state: UpdateState): MessageId | undefined {
  switch (state) {
    case "idle":
      return undefined;
    case "checking":
      return "update.status.checking";
    case "upToDate":
      return "update.status.upToDate";
    case "updateAvailable":
      return "update.status.available";
    case "error":
      return "update.status.error";
    case "offline":
      return "update.status.offline";
  }
}
