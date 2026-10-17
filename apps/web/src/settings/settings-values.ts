import type { PropertyValue } from "@openpaint/properties";
import type { SettingColor, SettingValue } from "@openpaint/storage";

/** A colour as the property editors use it: floats in [0, 1]. */
interface PropertyColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

function isStoredColor(value: unknown): value is SettingColor {
  return (
    typeof value === "object" && value !== null && "r" in value && "g" in value && "b" in value
  );
}

function isPropertyColor(value: unknown): value is PropertyColor {
  return (
    typeof value === "object" && value !== null && "r" in value && "g" in value && "b" in value
  );
}

function channelByte(channel: number): number {
  return Math.round(Math.min(1, Math.max(0, channel)) * 255);
}

/** The property value of a stored setting value (colours go from 0-255 to floats). */
export function toPropertyValue(value: SettingValue): PropertyValue {
  if (isStoredColor(value)) {
    return { r: value.r / 255, g: value.g / 255, b: value.b / 255, a: 1 };
  }
  return value as PropertyValue;
}

/** The stored setting value of a property value (colours go from floats to 0-255). */
export function toStoredValue(value: PropertyValue): SettingValue {
  if (isPropertyColor(value)) {
    return { r: channelByte(value.r), g: channelByte(value.g), b: channelByte(value.b), a: 255 };
  }
  return value;
}
