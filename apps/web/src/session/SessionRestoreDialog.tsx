import { useTranslation } from "@openpaint/i18n/react";
import { useState } from "react";
import { Button } from "react-aria-components";
import { ModalDialog } from "../shell/ModalDialog";
import type { SessionOffer } from "./session-recovery";

export interface SessionRestoreDialogProps {
  readonly offers: readonly SessionOffer[];
  readonly onRestore: () => void;
  readonly onDiscard: () => void;
}

/**
 * "Restore N images from your last session?" with Restore and Discard (SET-LIFE-11). Discard asks
 * once more before the checkpoints are deleted. Esc does nothing, so the user must answer.
 */
export function SessionRestoreDialog({ offers, onRestore, onDiscard }: SessionRestoreDialogProps) {
  const t = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const count = offers.length;
  if (confirming) {
    return (
      <ModalDialog isOpen onClose={() => setConfirming(false)} title={t("session.title")}>
        <p>{t("session.discard.question", { count })}</p>
        <div className="modal-actions">
          <Button onPress={() => setConfirming(false)}>{t("dialog.cancel")}</Button>
          <Button className="is-default" onPress={onDiscard}>
            {t("session.restore.discard")}
          </Button>
        </div>
      </ModalDialog>
    );
  }
  return (
    <ModalDialog isOpen onClose={() => undefined} title={t("session.title")} closable={false}>
      <p>{t("session.restore.question", { count })}</p>
      <div className="modal-actions">
        <Button onPress={() => setConfirming(true)}>{t("session.restore.discard")}</Button>
        <Button className="is-default" onPress={onRestore}>
          {t("session.restore.restore")}
        </Button>
      </div>
    </ModalDialog>
  );
}
