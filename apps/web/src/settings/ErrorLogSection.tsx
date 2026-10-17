import { useTranslation } from "@openpaint/i18n/react";
import { useState, useSyncExternalStore } from "react";
import { Button, ToggleButton } from "react-aria-components";
import type { ErrorReporter } from "../errors/reporter";
import { ModalDialog } from "../shell/ModalDialog";

/**
 * SET-DLG-12: the local error log, newest first. Selecting an entry shows its full text. "Copy
 * error log" copies the selected entry, or every entry when none is selected. Clearing asks first.
 */
export function ErrorLogSection({ errors }: { readonly errors: ErrorReporter }) {
  const t = useTranslation();
  const { log } = errors;
  const entries = useSyncExternalStore(log.subscribe, () => log.entries);
  const [selectedId, setSelectedId] = useState<number>();
  const [confirmClear, setConfirmClear] = useState(false);
  const [status, setStatus] = useState<string>();
  const selected = entries.find((entry) => entry.id === selectedId);

  const copy = async () => {
    const text = selected?.text ?? entries.map((entry) => entry.text).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setStatus(t("settings.diagnostics.errorLogCopied"));
    } catch {
      setStatus(t("settings.diagnostics.copyFailed"));
    }
  };

  return (
    <section className="settings-error-log">
      <h3>{t("settings.diagnostics.errorLog")}</h3>
      {entries.length === 0 ? (
        <p>{t("settings.diagnostics.errorLogEmpty")}</p>
      ) : (
        <div className="settings-error-log-body">
          <ul className="settings-error-list">
            {entries.map((entry) => (
              <li key={entry.id}>
                <ToggleButton
                  isSelected={entry.id === selectedId}
                  onChange={(isSelected) => setSelectedId(isSelected ? entry.id : undefined)}
                >
                  {`${entry.time} ${entry.title}`}
                </ToggleButton>
              </li>
            ))}
          </ul>
          <pre className="settings-error-text">
            {selected?.text ?? t("settings.diagnostics.errorLogSelect")}
          </pre>
        </div>
      )}
      <div className="settings-actions">
        <Button isDisabled={entries.length === 0} onPress={() => void copy()}>
          {t("settings.diagnostics.errorLogCopy")}
        </Button>
        <Button isDisabled={entries.length === 0} onPress={() => setConfirmClear(true)}>
          {t("settings.diagnostics.errorLogClear")}
        </Button>
      </div>
      {status !== undefined && (
        <p aria-live="polite" className="settings-status">
          {status}
        </p>
      )}
      <ModalDialog
        isOpen={confirmClear}
        onClose={() => setConfirmClear(false)}
        title={t("settings.diagnostics.errorLogClearTitle")}
      >
        <p>{t("settings.diagnostics.errorLogClearMessage")}</p>
        <div className="modal-actions">
          <Button onPress={() => setConfirmClear(false)}>{t("dialog.cancel")}</Button>
          <Button
            className="is-default"
            onPress={() => {
              log.clear();
              setSelectedId(undefined);
              setConfirmClear(false);
            }}
          >
            {t("settings.diagnostics.errorLogClearConfirm")}
          </Button>
        </div>
      </ModalDialog>
    </section>
  );
}
