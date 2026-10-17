import { useTranslation } from "@openpaint/i18n/react";
import { Button } from "react-aria-components";
import { ModalDialog } from "./ModalDialog";

/** A dirty image listed in the dialog. */
export interface UnsavedImage {
  readonly id: string;
  readonly name: string;
  readonly thumbnail?: string | undefined;
}

export interface UnsavedChangesDialogProps {
  /** The unsaved images in tab order. One image uses the single-image form (UI-DOC-03). */
  readonly images: readonly UnsavedImage[];
  /** Saves the images and then closes them. Undefined disables Save. */
  readonly onSave?: () => void;
  /** Closes the images and throws away their changes. */
  readonly onDiscard: () => void;
  readonly onCancel: () => void;
  /** Makes a listed image the active one, from its thumbnail (UI-DOC-04). */
  readonly onActivate: (id: string) => void;
}

/**
 * The "Unsaved Changes" dialog (UI-DOC-03, UI-DOC-04, FMT-CLOSE-01). It has the single-image
 * text and buttons for one image, and the thumbnail list with the wording of several images.
 * Esc and Cancel leave everything open.
 */
export function UnsavedChangesDialog({
  images,
  onSave,
  onDiscard,
  onCancel,
  onActivate,
}: UnsavedChangesDialogProps) {
  const t = useTranslation();
  const single = images.length === 1;
  const [first] = images;
  return (
    <ModalDialog isOpen onClose={onCancel} title={t("close.unsaved.title")} wide={!single}>
      <p>
        {single && first !== undefined
          ? t("close.unsaved.single", { name: first.name })
          : t("close.unsaved.several")}
      </p>
      {!single && (
        <>
          <h3 className="unsaved-heading">{t("close.unsaved.images")}</h3>
          <ul className="unsaved-list">
            {images.map((image) => (
              <li key={image.id}>
                <Button className="unsaved-thumb" onPress={() => onActivate(image.id)}>
                  {image.thumbnail !== undefined && <img src={image.thumbnail} alt="" />}
                  <span>{image.name}</span>
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="modal-actions">
        <Button
          isDisabled={onSave === undefined}
          onPress={onSave}
          aria-description={
            single ? t("close.unsaved.saveHint.single") : t("close.unsaved.saveHint.several")
          }
        >
          {t("close.unsaved.save")}
        </Button>
        <Button
          onPress={onDiscard}
          aria-description={
            single ? t("close.unsaved.discardHint.single") : t("close.unsaved.discardHint.several")
          }
        >
          {t("close.unsaved.discard")}
        </Button>
        <Button
          className="is-default"
          onPress={onCancel}
          aria-description={t("close.unsaved.cancelHint")}
        >
          {t("dialog.cancel")}
        </Button>
      </div>
    </ModalDialog>
  );
}
