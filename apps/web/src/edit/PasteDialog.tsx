import type { ClipboardImage } from "@openpaint/document";
import { useTranslation } from "@openpaint/i18n/react";
import { useMemo } from "react";
import { Button } from "react-aria-components";
import { ModalDialog } from "../shell/ModalDialog";
import { surfaceToDataUrl } from "../tabs/thumbnail-url";
import type { PasteChoice } from "./document-commands";

export interface PasteDialogProps {
  /** The image waiting to be pasted. The dialog is open while it is set. */
  readonly image: ClipboardImage | undefined;
  readonly onChoose: (choice: PasteChoice) => void;
}

/**
 * The "Paste" prompt for an image larger than the canvas (UI-MENU-EDIT-03, DOC-CLP-05). Esc is
 * Cancel. Expand canvas is the default button.
 */
export function PasteDialog({ image, onChoose }: PasteDialogProps) {
  const t = useTranslation();
  const thumbnail = useMemo(
    () => (image === undefined ? undefined : surfaceToDataUrl(image.pixels)),
    [image],
  );
  return (
    <ModalDialog
      isOpen={image !== undefined}
      onClose={() => onChoose("cancel")}
      title={t("paste.title")}
    >
      <p>{t("paste.larger")}</p>
      {thumbnail !== undefined && (
        <img className="paste-thumbnail" src={thumbnail} alt={t("paste.thumbnailAlt")} />
      )}
      <div className="modal-actions">
        <Button
          className="is-default"
          aria-description={t("paste.expandHelp")}
          onPress={() => onChoose("expand")}
        >
          {t("paste.expand")}
        </Button>
        <Button aria-description={t("paste.keepHelp")} onPress={() => onChoose("keep")}>
          {t("paste.keep")}
        </Button>
        <Button onPress={() => onChoose("cancel")}>{t("dialog.cancel")}</Button>
      </div>
    </ModalDialog>
  );
}
