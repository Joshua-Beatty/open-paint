import { I18nProvider, useTranslation } from "@openpaint/i18n/react";
import { DialogTitleBar } from "@openpaint/ui";
import { useEffect, useState } from "react";
import { Button, Dialog, Modal, ModalOverlay } from "react-aria-components";
import { createRoot } from "react-dom/client";
import type { ErrorReport, ErrorReporter } from "./reporter";
import "./errors.css";

export interface FatalErrorDialogProps {
  readonly report: ErrorReport;
  readonly onReload: () => void;
}

/**
 * SET-ERR-02: "OpenPaint Error". It cannot be dismissed, because the app may be in an unusable
 * state. Reloading does not prompt for saves. The next launch offers session restore instead.
 */
export function FatalErrorDialog({ report, onReload }: FatalErrorDialogProps) {
  const t = useTranslation();
  const [showDetails, setShowDetails] = useState(false);
  const [status, setStatus] = useState<string>();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report.entry.text);
      setStatus(t("error.copied"));
    } catch {
      setStatus(t("error.copyFailed"));
    }
  };
  return (
    <ModalOverlay className="modal-overlay" isOpen isDismissable={false} isKeyboardDismissDisabled>
      <Modal className="modal modal-wide">
        <Dialog className="modal-dialog">
          <DialogTitleBar title={t("error.fatal.title")} />
          <p>{t("error.fatal.message")}</p>
          <Button
            className="error-details-toggle"
            aria-expanded={showDetails}
            aria-controls="error-details"
            onPress={() => setShowDetails((open) => !open)}
          >
            {showDetails ? t("error.fatal.hideDetails") : t("error.fatal.showDetails")}
          </Button>
          {showDetails && (
            <pre id="error-details" className="error-details">
              {report.entry.text}
            </pre>
          )}
          {status !== undefined && <p role="status">{status}</p>}
          <div className="modal-actions">
            <Button onPress={() => void copy()}>{t("error.fatal.copy")}</Button>
            <Button className="is-default" onPress={onReload}>
              {t("error.fatal.reload")}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** Shows the most recent fatal report. It runs in its own React root, outside the app tree. */
export function FatalErrorHost({
  reporter,
  onReload,
}: {
  readonly reporter: ErrorReporter;
  readonly onReload: () => void;
}) {
  const [report, setReport] = useState<ErrorReport>();
  useEffect(() => reporter.onFatal(setReport), [reporter]);
  return report === undefined ? null : <FatalErrorDialog report={report} onReload={onReload} />;
}

/**
 * Mounts the fatal error host in its own root, so the dialog still shows when the app tree has
 * failed. Returns the function that unmounts it.
 */
export function mountFatalErrorHost(reporter: ErrorReporter, onReload: () => void): () => void {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  root.render(
    <I18nProvider>
      <FatalErrorHost reporter={reporter} onReload={onReload} />
    </I18nProvider>,
  );
  return () => {
    root.unmount();
    container.remove();
  };
}
