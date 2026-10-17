import { shapeCategories } from "@openpaint/extension-api";
import type { MessageId } from "@openpaint/i18n";
import { useTranslation } from "@openpaint/i18n/react";
import type { SettingsStore } from "@openpaint/storage";
import { DropdownChevron, OptionIcon, TooltipTrigger } from "@openpaint/ui";
import {
  Button,
  Header,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  Popover,
  Select,
  SelectValue,
  Tooltip,
} from "react-aria-components";
import { REMIX } from "../icons/icon-set";
import { useSetting } from "../settings/use-setting";
import { DEFAULT_SHAPE_ID, SHAPE_REGISTRY, SHAPE_SETTING_PATH } from "./shape-catalog";
import { shapeIcon } from "./shape-icons";
import { STRIP_ITEM } from "./strip-item";
import "./tools.css";

/** The shape picker's icon when no shape is selected: the Shapes tool's icon. */
const SHAPES_ICON = REMIX.shapes;

export interface ShapeOptionsProps {
  readonly settings: SettingsStore;
  /** Opens a tool instead of drawing, for the shapes that name one (Line / Curve). */
  readonly onSelectTool?: (id: string) => void;
}

/**
 * The shape type drop-down of the Shapes tool (TL-SHAPE-01). Its groups, order and entries come from
 * the shape registry (TL-SHAPE-02). A shape that names a tool opens that tool rather than being stored.
 * Each entry, and the button, shows the shape's outline as its icon (shapeIcon).
 */
export function ShapeOptions({ settings, onSelectTool }: ShapeOptionsProps) {
  const t = useTranslation();
  const stored = useSetting(settings, SHAPE_SETTING_PATH);
  const name =
    typeof stored === "object" && stored !== null ? (stored as { name?: unknown }).name : undefined;
  const selected = SHAPE_REGISTRY.get(typeof name === "string" ? name : DEFAULT_SHAPE_ID);
  const groups = shapeCategories(SHAPE_REGISTRY);
  const label = t("tool.shapes.type");
  const value = selected === undefined ? "" : t(selected.label);
  return (
    <div className="shape-options">
      <Select
        aria-label={label}
        className="prop-select"
        selectedKey={selected?.id ?? null}
        onSelectionChange={(key) => {
          const shape = typeof key === "string" ? SHAPE_REGISTRY.get(key) : undefined;
          if (shape === undefined) return;
          if (shape.tool !== undefined) onSelectTool?.(shape.tool);
          else settings.set(SHAPE_SETTING_PATH, { name: shape.id });
        }}
        {...STRIP_ITEM}
      >
        <TooltipTrigger delay={500}>
          <Button className="prop-select-button is-inline">
            <SelectValue className="prop-select-value">
              {() => (
                <>
                  <OptionIcon path={selected === undefined ? SHAPES_ICON : shapeIcon(selected)} />
                  <span className="prop-select-text">{value}</span>
                </>
              )}
            </SelectValue>
            <DropdownChevron />
          </Button>
          <Tooltip className="prop-tooltip">
            {t("property.inlineTip", { name: label, value })}
          </Tooltip>
        </TooltipTrigger>
        <Popover className="prop-popover">
          <ListBox className="prop-listbox">
            {groups.map((group) => (
              <ListBoxSection key={group.category} className="prop-listbox-section">
                <Header className="prop-listbox-header">
                  {t(`shape.category.${group.category}` as MessageId)}
                </Header>
                {group.shapes.map((shape) => (
                  <ListBoxItem
                    key={shape.id}
                    id={shape.id}
                    className="prop-option"
                    textValue={t(shape.label)}
                  >
                    <OptionIcon path={shapeIcon(shape)} />
                    <span className="prop-option-label">{t(shape.label)}</span>
                  </ListBoxItem>
                ))}
              </ListBoxSection>
            ))}
          </ListBox>
        </Popover>
      </Select>
    </div>
  );
}
