/**
 * What a component is, which groups the license list: a font, an icon set, a JavaScript library,
 * a C or C++ library inside a codec's WebAssembly, or a Rust crate inside OpenPaint's.
 */
export type ComponentKind = "font" | "icons" | "library" | "codec" | "rust";

/** A bundled third-party component, generated from the app's dependency manifest (SET-HELP-02). */
export interface OpenSourceComponent {
  /** The package name. */
  readonly name: string;
  /** The name to show: the font family or icon set, else the package name. */
  readonly title: string;
  readonly kind: ComponentKind;
  readonly version: string;
  readonly license: string;
  readonly url: string;
  /** The copyright lines of the component, or "" when it states none. */
  readonly copyright: string;
  readonly licenseText: string;
}

/** The groups of the license list, in the order it shows them. */
export const COMPONENT_KINDS: readonly ComponentKind[] = [
  "font",
  "icons",
  "library",
  "codec",
  "rust",
];

/** The plain-text notices file the build writes next to the app shell (PRD-12). */
export const THIRD_PARTY_NOTICES_URL = `${import.meta.env.BASE_URL}THIRD-PARTY-NOTICES.txt`;

/** Loads the list on demand, so the component texts stay out of the start-up bundle. */
export function loadOpenSourceComponents(): Promise<readonly OpenSourceComponent[]> {
  return import("virtual:open-source-licenses").then((module) => module.default);
}
