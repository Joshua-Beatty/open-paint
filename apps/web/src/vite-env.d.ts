/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** The app version from package.json, defined by the Vite config. */
declare const __APP_VERSION__: string;

/** The build time as an ISO 8601 string, defined by the Vite config (SET-HELP-02). */
declare const __APP_BUILD_DATE__: string;

declare module "virtual:bundled-font-files" {
  /** The self-hosted URL of each bundled font file, in the order of `bundledFontFiles()`. */
  const files: readonly string[];
  export default files;
}

declare module "virtual:open-source-licenses" {
  const components: import("./help/open-source").OpenSourceComponent[];
  export default components;
}
