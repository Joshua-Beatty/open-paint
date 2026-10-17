import {
  type Document,
  type LayerProperties,
  MAX_LAYER_NAME_LENGTH,
  MAX_LAYER_OPACITY,
  MIN_LAYER_OPACITY,
} from "@openpaint/document";
import { useTranslation } from "@openpaint/i18n/react";
import { useState } from "react";
import {
  Button,
  Checkbox,
  Form,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  NumberField,
  Popover,
  Select,
  SelectValue,
  Slider,
  SliderThumb,
  SliderTrack,
  TextField,
} from "react-aria-components";
import { ModalDialog } from "../shell/ModalDialog";
import {
  BLEND_MODE_MESSAGES,
  draftProperties,
  LAYER_BLEND_MODE_ORDER,
  type LayerDraft,
  layerDraft,
  layerPropertyPatch,
} from "./layer-properties";

export interface LayerPropertiesDialogProps {
  /** The active image, or undefined when none is open. */
  readonly doc: Document | undefined;
  readonly isOpen: boolean;
  readonly onClose: () => void;
}

/**
 * Layer Properties for the active layer (DOC-LYR-02): name, visibility, blend mode and opacity.
 * Changes preview live on the canvas. OK records one history item and marks the document dirty.
 * Cancel and Esc restore the values the layer had when the dialog opened.
 */
export function LayerPropertiesDialog({ doc, isOpen, onClose }: LayerPropertiesDialogProps) {
  const layer = doc?.activeLayer;
  if (!isOpen || doc === undefined || layer === undefined) return null;
  return (
    <LayerPropertiesForm key={layer.id} doc={doc} initial={layer.properties} onClose={onClose} />
  );
}

interface LayerPropertiesFormProps {
  readonly doc: Document;
  /** The layer's properties when the dialog opened: what Cancel restores. */
  readonly initial: LayerProperties;
  readonly onClose: () => void;
}

function LayerPropertiesForm({ doc, initial, onClose }: LayerPropertiesFormProps) {
  const t = useTranslation();
  const [original] = useState(initial);
  const [draft, setDraft] = useState<LayerDraft>(() => layerDraft(initial));
  const update = (patch: Partial<LayerDraft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    doc.previewActiveLayerProperties(draftProperties(next));
  };
  const cancel = () => {
    doc.previewActiveLayerProperties(original);
    onClose();
  };
  const submit = () => {
    doc.previewActiveLayerProperties(original);
    doc.setActiveLayerProperties(layerPropertyPatch(original, draft));
    onClose();
  };

  return (
    <ModalDialog isOpen onClose={cancel} title={t("layers.dialog.title")} backdrop="clear">
      <Form
        className="layer-properties"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <h3 className="layer-properties-heading">{t("layers.dialog.general")}</h3>
        <TextField
          className="layer-properties-field"
          value={draft.name}
          onChange={(name) => update({ name })}
          maxLength={MAX_LAYER_NAME_LENGTH}
          autoFocus
        >
          <Label>{t("layers.dialog.name")}</Label>
          <Input />
        </TextField>
        <Checkbox isSelected={draft.visible} onChange={(visible) => update({ visible })}>
          {t("layers.dialog.visible")}
        </Checkbox>
        <Select
          className="layer-properties-field"
          selectedKey={draft.blendMode}
          onSelectionChange={(key) => {
            const mode = LAYER_BLEND_MODE_ORDER.find((candidate) => candidate === key);
            if (mode !== undefined) update({ blendMode: mode });
          }}
        >
          <Label>{t("layers.dialog.blendMode")}</Label>
          <Button>
            <SelectValue />
          </Button>
          <Popover>
            <ListBox>
              {LAYER_BLEND_MODE_ORDER.map((mode) => (
                <ListBoxItem key={mode} id={mode}>
                  {t(BLEND_MODE_MESSAGES[mode])}
                </ListBoxItem>
              ))}
            </ListBox>
          </Popover>
        </Select>
        <div className="layer-properties-opacity">
          <Slider
            className="layer-properties-slider"
            value={draft.opacity}
            onChange={(opacity) => update({ opacity })}
            minValue={MIN_LAYER_OPACITY}
            maxValue={MAX_LAYER_OPACITY}
            step={1}
          >
            <Label>{t("layers.dialog.opacity")}</Label>
            <SliderTrack className="app-slider-track">
              <SliderThumb />
            </SliderTrack>
          </Slider>
          <NumberField
            aria-label={t("layers.dialog.opacityValue")}
            value={draft.opacity}
            minValue={MIN_LAYER_OPACITY}
            maxValue={MAX_LAYER_OPACITY}
            step={1}
            onChange={(opacity) => {
              if (Number.isFinite(opacity)) update({ opacity });
            }}
          >
            <Input />
          </NumberField>
        </div>
        <div className="modal-actions">
          <Button onPress={cancel}>{t("layers.dialog.cancel")}</Button>
          <Button type="submit" className="is-default">
            {t("layers.dialog.ok")}
          </Button>
        </div>
      </Form>
    </ModalDialog>
  );
}
