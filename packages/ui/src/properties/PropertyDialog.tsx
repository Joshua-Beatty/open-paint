import { useTranslation } from "@openpaint/i18n/react";
import {
  PropertyCollection,
  type PropertySchema,
  type PropertyValues,
} from "@openpaint/properties";
import { type CSSProperties, useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogTrigger,
  Form,
  Modal,
  ModalOverlay,
  Popover,
} from "react-aria-components";
import { DialogTitleBar } from "../dialog/DialogTitleBar";
import { type DialogSettings, dialogSettings } from "./dialog-settings";
import { PropertyForm } from "./PropertyForm";
import type { PropertyServices } from "./services";
import "./property-dialog.css";

export interface PropertyDialogProps {
  readonly isOpen: boolean;
  readonly schema: PropertySchema;
  /** Starting values, usually the remembered last-used values. Resolved against the schema. */
  readonly values?: unknown;
  /** The dialog title. The schema's `dialogTitle` replaces it. */
  readonly title: string;
  readonly services?: PropertyServices;
  /** Called with every value when the user presses OK. */
  readonly onOk: (values: PropertyValues) => void;
  /** Called on Cancel, Esc or a click outside the dialog. Nothing is applied. */
  readonly onCancel: () => void;
  /** Called after every change, so the host can preview the values. */
  readonly onValuesChange?: (values: PropertyValues) => void;
  /** An inline notice shown under the controls, such as "nothing to align". */
  readonly notice?: string;
}

/**
 * The generated configuration dialog (FX-FW-UI-01, EXT-V1-02): an in-page modal with one control per
 * property, a separator, an optional help button, and OK and Cancel. It is built from the schema
 * alone, so a new effect or file type needs no dialog code. Each open starts from `values`.
 */
export function PropertyDialog({
  isOpen,
  schema,
  values,
  title,
  services = {},
  onOk,
  onCancel,
  onValuesChange,
  notice,
}: PropertyDialogProps) {
  const t = useTranslation();
  const settings = dialogSettings(schema);
  const heading = settings.title === undefined ? title : t(settings.title);
  return (
    <ModalOverlay
      className="modal-overlay"
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Modal
        className={settings.resizable ? "modal prop-dialog is-resizable" : "modal prop-dialog"}
        style={{ "--prop-dialog-scale": settings.widthScale } as CSSProperties}
      >
        <Dialog className="modal-dialog">
          <DialogTitleBar title={heading} onClose={onCancel} />
          <PropertyDialogForm
            schema={schema}
            values={values}
            settings={settings}
            services={services}
            label={heading}
            onOk={onOk}
            onCancel={onCancel}
            onValuesChange={onValuesChange}
            notice={notice}
          />
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

interface PropertyDialogFormProps {
  readonly schema: PropertySchema;
  readonly values: unknown;
  readonly settings: DialogSettings;
  readonly services: PropertyServices;
  /** The dialog's translated title, which names any control whose caption is blank. */
  readonly label: string;
  readonly onOk: (values: PropertyValues) => void;
  readonly onCancel: () => void;
  readonly onValuesChange?: (values: PropertyValues) => void;
  readonly notice: string | undefined;
}

/** Mounted per open, so every open starts from the remembered values. */
function PropertyDialogForm({
  schema,
  values,
  settings,
  services,
  label,
  onOk,
  onCancel,
  onValuesChange,
  notice,
}: PropertyDialogFormProps) {
  const t = useTranslation();
  const [collection] = useState(() => new PropertyCollection(schema, values));

  useEffect(() => {
    if (onValuesChange === undefined) return undefined;
    return collection.on("valueChanged", () => onValuesChange(collection.values()));
  }, [collection, onValuesChange]);

  return (
    <Form
      className="prop-dialog-form"
      onSubmit={(event) => {
        event.preventDefault();
        onOk(collection.values());
      }}
    >
      <PropertyForm collection={collection} services={services} label={label} />
      {notice !== undefined && (
        <p className="prop-dialog-notice" role="status">
          {notice}
        </p>
      )}
      {settings.bottomSeparator && <hr className="prop-dialog-separator" />}
      <div className="modal-actions prop-dialog-actions">
        <HelpButton settings={settings} services={services} />
        <Button onPress={onCancel}>{t("dialog.cancel")}</Button>
        <Button type="submit" className="is-default">
          {t("dialog.ok")}
        </Button>
      </div>
    </Form>
  );
}

function HelpButton({
  settings,
  services,
}: {
  readonly settings: DialogSettings;
  readonly services: PropertyServices;
}) {
  const t = useTranslation();
  if (settings.help === "none") return null;
  if (settings.help === "custom") {
    const onHelpRequested = services.onHelpRequested;
    if (onHelpRequested === undefined) return null;
    return (
      <Button onPress={() => onHelpRequested(settings.helpContent)}>{t("property.help")}</Button>
    );
  }
  const text = settings.helpMessage === undefined ? settings.helpContent : t(settings.helpMessage);
  return (
    <DialogTrigger>
      <Button>{t("property.help")}</Button>
      <Popover placement="top">
        <Dialog aria-label={t("property.help")} className="prop-help">
          <p>{text}</p>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
