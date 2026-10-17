// Starts the installed desktop Firefox as a Playwright browser server over WebDriver BiDi, so the
// browser runner can check the WGSL kernels on Firefox's own WebGPU (Playwright's bundled Firefox has
// none). Leave it running and, in another shell:
//   GOLDEN_FIREFOX_WS=<printed endpoint> pnpm --filter @openpaint/golden test:browser --project firefox
import { firefox } from "@playwright/test";

const server = await firefox.launchServer({
  channel: "moz-firefox",
  headless: process.env.HEADLESS === "1",
});
console.log(server.wsEndpoint());
