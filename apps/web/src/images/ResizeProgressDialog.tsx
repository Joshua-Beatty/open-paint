import { useTranslation } from "@openpaint/i18n/react";
import { Button } from "react-aria-components";
import { ModalDialog } from "../shell/ModalDialog";

export interface ResizeProgressDialogProps {
  readonly isOpen: boolean;
  /** The percent resampled so far, or undefined before the first layer is done. */
  readonly percent: number | undefined;
  /** True once Cancel is pressed and the job is stopping. */
  readonly canceling: boolean;
  /** Cancel and Esc stop the job (DOC-IMG-02). The image is unchanged after a cancel. */
  readonly onCancel: () => void;
}

/** The cancellable "Resizing..." dialog of DOC-IMG-02. Its header shows the progress. */
export function ResizeProgressDialog({
  isOpen,
  percent,
  canceling,
  onCancel,
}: ResizeProgressDialogProps) {
  const t = useTranslation();
  const header = canceling
    ? t("image.progress.canceling")
    : percent === undefined
      ? t("image.progress.resizing")
      : t("image.progress.percent", { percent });
  return (
    <ModalDialog
      isOpen={isOpen}
      onClose={onCancel}
      title={t("image.resize.title")}
      closeDisabled={canceling}
    >
      <p role="status" aria-live="polite">
        {header}
      </p>
      <div className="modal-actions">
        <Button isDisabled={canceling} onPress={onCancel}>
          {t("dialog.cancel")}
        </Button>
      </div>
    </ModalDialog>
  );
}
