import { useTranslation } from "@openpaint/i18n/react";
import { useState } from "react";
import { Button, Dialog, Modal, ModalOverlay } from "react-aria-components";
import { DialogTitleBar } from "../dialog/DialogTitleBar";
import "./property-dialog.css";

export interface RenderProgressDialogProps {
  readonly isOpen: boolean;
  /** The effect's name (FX-FW-PROGRESS-01). */
  readonly title: string;
  /** The percent written so far, or undefined while the effect is still being computed. */
  readonly percent: number | undefined;
  readonly canceling: boolean;
  readonly onCancel: () => void;
}

/**
 * The "Rendering..." dialog that stays open while an effect finishes (FX-FW-PROGRESS-01). Esc and
 * Cancel both stop the render. Once the render is stopping, the header reads "Canceling...", a
 * "Finishing..." wait line shows, and the Cancel button is gone.
 */
export function RenderProgressDialog({
  isOpen,
  title,
  percent,
  canceling,
  onCancel,
}: RenderProgressDialogProps) {
  const t = useTranslation();
  const header = canceling
    ? t("effect.progress.canceling")
    : percent === undefined
      ? t("effect.progress.initializing")
      : t("effect.progress.percent", { percent });
  return (
    <ModalOverlay
      className="modal-overlay"
      isOpen={isOpen}
      isDismissable={false}
      onOpenChange={(open) => {
        if (!open && !canceling) onCancel();
      }}
    >
      <Modal className="modal">
        <Dialog className="modal-dialog" aria-label={title}>
          <DialogTitleBar title={title} onClose={canceling ? undefined : onCancel} />
          <p role="status" aria-live="polite">
            {header}
          </p>
          {canceling ? (
            <p>{t("effect.progress.finishing")}</p>
          ) : (
            <div className="modal-actions">
              <Button onPress={onCancel}>{t("dialog.cancel")}</Button>
            </div>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

export interface EffectErrorDialogProps {
  readonly isOpen: boolean;
  readonly title: string;
  readonly message: string;
  readonly onClose: () => void;
  /** The underlying error. When given, the dialog offers "Show details" and "Copy to clipboard". */
  readonly details?: string;
  /** Opens Settings › Diagnostics for the error log (SET-ERR-03 "View error log"). */
  readonly onViewErrorLog?: () => void;
}

/**
 * The message shown when an effect cannot be applied (FX-FW-ERR-01). It follows SET-ERR-03: the
 * details can be shown and copied, and the error log can be opened.
 */
export function EffectErrorDialog({
  isOpen,
  title,
  message,
  onClose,
  details,
  onViewErrorLog,
}: EffectErrorDialogProps) {
  const t = useTranslation();
  const [showDetails, setShowDetails] = useState(false);
  return (
    <ModalOverlay
      className="modal-overlay"
      isOpen={isOpen}
      onOpenChange={(open) => !open && onClose()}
    >
      <Modal className="modal">
        <Dialog className="modal-dialog">
          <DialogTitleBar title={title} onClose={onClose} />
          <p>{message}</p>
          {details !== undefined && (
            <>
              <Button
                aria-expanded={showDetails}
                aria-controls="effect-error-details"
                onPress={() => setShowDetails((open) => !open)}
              >
                {showDetails ? t("error.exception.hideDetails") : t("error.exception.showDetails")}
              </Button>
              {showDetails && (
                <pre id="effect-error-details" className="error-details">
                  {details}
                </pre>
              )}
            </>
          )}
          {/* With nothing to copy or open, Close would be the only button: the title bar has it. */}
          {(details !== undefined || onViewErrorLog !== undefined) && (
            <div className="modal-actions">
              {details !== undefined && (
                <Button
                  onPress={() =>
                    void navigator.clipboard?.writeText(details).catch(() => undefined)
                  }
                >
                  {t("error.exception.copy")}
                </Button>
              )}
              {onViewErrorLog !== undefined && (
                <Button onPress={onViewErrorLog}>{t("error.exception.viewLog")}</Button>
              )}
              <Button className="is-default" onPress={onClose}>
                {t("dialog.close")}
              </Button>
            </div>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
