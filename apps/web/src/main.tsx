import { initCpu } from "@openpaint/engine";
import { t } from "@openpaint/i18n";
import { I18nProvider } from "@openpaint/i18n/react";
import {
  ErrorLog,
  IndexedDbErrorLogBackend,
  IndexedDbRecentFilesBackend,
  RecentFiles,
} from "@openpaint/storage";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { mountFatalErrorHost } from "./errors/FatalErrorDialog";
import { installErrorHandlers } from "./errors/global-handlers";
import { ErrorReporter } from "./errors/reporter";
import { InstallHint, isInstalledApp } from "./help/install-prompt";
import { startServiceWorkerUpdates } from "./help/service-worker";
import { perfMonitor } from "./perf/perf-monitor";
import { installSpillProcessor } from "./workers/spill-processor";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root element");
}

// The benchmark instrumentation (`?perf=1`) records from the start. Without the flag it does not exist.
perfMonitor?.install(window);

// SET-LIFE-01 step 5: the handlers go in before anything else can fail, so start-up errors are logged too.
const errors = new ErrorReporter({
  log: await ErrorLog.open(new IndexedDbErrorLogBackend()),
  version: __APP_VERSION__,
  translate: t,
});
installErrorHandlers(window, errors);
mountFatalErrorHost(errors, () => window.location.reload());

// The install event can fire while start-up waits below, so the hint listens from the start.
const install = new InstallHint({ installed: isInstalledApp() });
install.attach(window);

// Tab thumbnails and the document's pixel work run on this thread, so the CPU kernels load first.
await initCpu();
// History snapshots are LZ4-coded in a worker, so a commit or checkpoint does not block the page.
installSpillProcessor();

const updates = startServiceWorkerUpdates();
const recent = await RecentFiles.open(new IndexedDbRecentFilesBackend());

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <App updates={updates} install={install} errors={errors} recent={recent} />
    </I18nProvider>
  </StrictMode>,
);
