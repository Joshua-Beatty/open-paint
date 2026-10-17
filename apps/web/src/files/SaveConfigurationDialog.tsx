import { useTranslation } from "@openpaint/i18n/react";
import { defaultValues, PropertyCollection } from "@openpaint/properties";
import { PropertyForm } from "@openpaint/ui";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "react-aria-components";
import { AccessLabel } from "../shell/MenuBar";
import { ModalDialog } from "../shell/ModalDialog";
import { surfaceToDataUrl } from "../tabs/thumbnail-url";
import type { SaveConfigChoice, SaveConfigRequest } from "./file-dialogs";
import { previewSizeText, SavePreview } from "./save-preview";
import "./files.css";

export interface SaveConfigurationDialogProps extends SaveConfigRequest {
  readonly answer: (choice: SaveConfigChoice | undefined) => void;
}

/**
 * The Save Configuration dialog (FMT-UI-01..03): the type's options, generated from its schema on
 * the left, and the live preview with its file size on the right. OK waits for the final preview,
 * so the write can reuse its bytes, and Defaults resets every option.
 */
export function SaveConfigurationDialog({
  type,
  codec,
  file,
  values,
  answer,
}: SaveConfigurationDialogProps) {
  const t = useTranslation();
  const [collection] = useState(() => new PropertyCollection(type.saveOptions, values));
  const [preview] = useState(() => new SavePreview(codec, type, file));
  const state = useSyncExternalStore(preview.subscribe, () => preview.state);
  const [finishing, setFinishing] = useState(false);
  const imageUrl = useMemo(
    () => (state.kind === "ready" ? surfaceToDataUrl(state.image) : undefined),
    [state],
  );

  useEffect(() => {
    preview.update(collection.values());
    const stop = collection.on("valueChanged", () => preview.update(collection.values()));
    return () => {
      stop();
      preview.cancel();
    };
  }, [collection, preview]);

  const submit = async () => {
    setFinishing(true);
    const settled = await preview.settled();
    answer({
      values: collection.values(),
      encoded: settled.kind === "ready" ? settled.bytes : undefined,
    });
  };

  return (
    <ModalDialog isOpen onClose={() => answer(undefined)} title={t("file.saveConfig.title")} wide>
      <form
        className="save-config"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="save-config-body">
          <section className="save-config-settings">
            <h3 className="save-config-heading">
              <AccessLabel text={t("file.saveConfig.settings")} />
            </h3>
            <PropertyForm collection={collection} />
          </section>
          <section className="save-config-preview">
            <h3 className="save-config-heading">
              {t("file.saveConfig.preview", { size: previewSizeText(state, t) })}
            </h3>
            <div className="save-config-image">
              {imageUrl !== undefined && (
                <img src={imageUrl} alt={t("file.saveConfig.previewAlt")} />
              )}
            </div>
          </section>
        </div>
        <div className="modal-actions">
          <Button onPress={() => collection.copyFrom(defaultValues(type.saveOptions))}>
            <AccessLabel text={t("file.saveConfig.defaults")} />
          </Button>
          <Button onPress={() => answer(undefined)}>{t("dialog.cancel")}</Button>
          <Button type="submit" className="is-default" isDisabled={finishing}>
            {t("dialog.ok")}
          </Button>
        </div>
        {finishing && <p role="status">{t("file.saveConfig.finishing")}</p>}
      </form>
    </ModalDialog>
  );
}
