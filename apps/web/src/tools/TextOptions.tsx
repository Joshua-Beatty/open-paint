import type { MessageId } from "@openpaint/i18n";
import { useTranslation } from "@openpaint/i18n/react";
import type { SettingsStore } from "@openpaint/storage";
import { DropdownChevron, OptionIcon, TooltipTrigger } from "@openpaint/ui";
import { type ChangeEvent, useRef, useState, useSyncExternalStore } from "react";
import {
  Button,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
  ToggleButton,
  Tooltip,
} from "react-aria-components";
import { useSetting } from "../settings/use-setting";
import { fontCatalog } from "../text/font-store";
import { TEXT_STYLES, type TextStyle, textStyles, toggleTextStyle } from "../text/text-options";
import { STRIP_ITEM } from "./strip-item";
import "./tools.css";

/** The stored font family setting (TL-OPT-TEXT "Font"). */
export const FONT_FAMILY_PATH = "tools.text.fontFamily";

/** The stored style setting: a comma-separated list of the styles that are on. */
export const FONT_STYLE_PATH = "tools.text.fontStyle";

const STYLE_LABELS = {
  Bold: "tool.text.styleBold",
  Italic: "tool.text.styleItalic",
  Underline: "tool.text.styleUnderline",
  Strikeout: "tool.text.styleStrikeout",
} as const satisfies Record<TextStyle, MessageId>;

const STYLE_GLYPHS = {
  Bold: "tool.text.glyphBold",
  Italic: "tool.text.glyphItalic",
  Underline: "tool.text.glyphUnderline",
  Strikeout: "tool.text.glyphStrikeout",
} as const satisfies Record<TextStyle, MessageId>;

const FONT_FILE_TYPES = ".ttf,.otf,.woff,.woff2";

/** A letter A with a plus: add a font file. */
const ADD_FONT_ICON = "M1.5 13 5 3l3.5 10M2.7 9.5h4.6M12 5v6M9 8h6";
/** A monitor: the fonts installed on this computer. */
const INSTALLED_FONTS_ICON = "M1.5 2.5h13v9h-13zM5.5 14.5h5M8 11.5v3";

/** An icon-only options bar button, named by its tooltip. */
function IconButton({
  label,
  icon,
  disabled = false,
  onPress,
}: {
  readonly label: string;
  readonly icon: string;
  readonly disabled?: boolean;
  readonly onPress?: () => void;
}) {
  return (
    <TooltipTrigger delay={500}>
      <Button
        className="tool-icon-button"
        aria-label={label}
        isDisabled={disabled}
        onPress={onPress}
        {...STRIP_ITEM}
      >
        <OptionIcon path={icon} />
      </Button>
      <Tooltip className="prop-tooltip">{label}</Tooltip>
    </TooltipTrigger>
  );
}

/**
 * The font controls of the Text tool (TL-OPT-TEXT): the family list with a live sample, the way to
 * add an uploaded font (WEB-FONT-01), the request for installed fonts (where the browser permits
 * it), and the Bold, Italic, Underline and Strikeout toggles.
 */
export function TextOptions({ settings }: { readonly settings: SettingsStore }) {
  const t = useTranslation();
  const catalog = useSyncExternalStore(fontCatalog.subscribe, () => fontCatalog.state);
  const storedFamily = useSetting(settings, FONT_FAMILY_PATH);
  const storedStyle = useSetting(settings, FONT_STYLE_PATH);
  const family = fontCatalog.resolve(storedFamily);
  const styles = textStyles(storedStyle);
  const fileInput = useRef<HTMLInputElement>(null);
  const [fontError, setFontError] = useState(false);
  const addFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const added = await fontCatalog.addUpload(file.name, bytes);
      settings.set(FONT_FAMILY_PATH, added);
      setFontError(false);
    } catch {
      setFontError(true);
    }
  };
  const installedReady = catalog.local === "loading" || catalog.local === "ready";
  return (
    <div className="text-options">
      <Select
        aria-label={t("tool.text.font")}
        className="prop-select"
        selectedKey={family}
        onSelectionChange={(key) => {
          if (typeof key === "string") settings.set(FONT_FAMILY_PATH, key);
        }}
        {...STRIP_ITEM}
      >
        <TooltipTrigger delay={500}>
          <Button className="prop-select-button is-inline text-options-font">
            <SelectValue className="prop-select-value" />
            <DropdownChevron />
          </Button>
          <Tooltip className="prop-tooltip">
            {t("property.inlineTip", { name: t("tool.text.fontName"), value: family })}
          </Tooltip>
        </TooltipTrigger>
        <Popover className="prop-popover">
          <ListBox className="prop-listbox text-options-fonts">
            {catalog.families.map((entry) => (
              <ListBoxItem
                key={entry.family}
                id={entry.family}
                className="prop-option"
                textValue={entry.family}
              >
                {/* Each name in its own face; the browser fetches the face when it is shown. */}
                <span style={{ fontFamily: `"${entry.family}", sans-serif` }}>{entry.family}</span>
              </ListBoxItem>
            ))}
          </ListBox>
        </Popover>
      </Select>
      <span
        className="text-options-sample"
        style={{ fontFamily: `"${family}", sans-serif` }}
        {...STRIP_ITEM}
      >
        {t("tool.text.fontSample")}
      </span>
      {catalog.local === "loading" ? (
        <span className="text-options-note" role="status" {...STRIP_ITEM}>
          {t("tool.text.fontLoading")}
        </span>
      ) : null}
      <IconButton
        label={t("tool.text.addFont")}
        icon={ADD_FONT_ICON}
        onPress={() => fileInput.current?.click()}
      />
      <input
        ref={fileInput}
        type="file"
        accept={FONT_FILE_TYPES}
        hidden
        onChange={(event) => void addFile(event)}
      />
      {fontError ? (
        <span className="text-options-note" role="alert" {...STRIP_ITEM}>
          {t("tool.text.fontError")}
        </span>
      ) : null}
      {catalog.local === "unavailable" ? (
        <IconButton
          label={t("tool.text.installedUnavailable")}
          icon={INSTALLED_FONTS_ICON}
          disabled
        />
      ) : (
        <IconButton
          label={t("tool.text.installedFonts")}
          icon={INSTALLED_FONTS_ICON}
          disabled={installedReady}
          onPress={() => void fontCatalog.loadLocal()}
        />
      )}
      {catalog.local === "denied" ? (
        <span className="text-options-note" role="alert" {...STRIP_ITEM}>
          {t("tool.text.installedDenied")}
        </span>
      ) : null}
      <fieldset className="text-options-styles" aria-label={t("tool.text.styles")} {...STRIP_ITEM}>
        {TEXT_STYLES.map((style) => (
          <TooltipTrigger key={style} delay={500}>
            <ToggleButton
              className="tool-icon-button text-options-style"
              aria-label={t(STYLE_LABELS[style])}
              isSelected={styles.has(style)}
              onChange={() => settings.set(FONT_STYLE_PATH, toggleTextStyle(storedStyle, style))}
            >
              <span className={`text-options-glyph is-${style.toLowerCase()}`}>
                {t(STYLE_GLYPHS[style])}
              </span>
            </ToggleButton>
            <Tooltip className="prop-tooltip">{t(STYLE_LABELS[style])}</Tooltip>
          </TooltipTrigger>
        ))}
      </fieldset>
    </div>
  );
}
