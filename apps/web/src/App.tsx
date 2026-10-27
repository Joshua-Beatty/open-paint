import {
  browserClipboard,
  browserCodecs,
  builtinFileTypeRegistry,
  ClipboardService,
} from "@openpaint/codecs";
import {
  type ClipboardImage,
  type ColorRgba8,
  type Document,
  documentThumbnail,
} from "@openpaint/document";
import { builtinEffectBindings, EffectMemory, registerBuiltinEffects } from "@openpaint/effects";
import {
  type EngineError,
  EngineGpuOffloader,
  type EngineHandle,
  engineShowsFloat,
} from "@openpaint/engine";
import { EffectRegistry } from "@openpaint/extension-api";
import { useTranslation } from "@openpaint/i18n/react";
import {
  ErrorLog,
  MemoryErrorLogBackend,
  MemoryRecentFilesBackend,
  RecentFiles,
  readEarlySetting,
} from "@openpaint/storage";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button, VisuallyHidden } from "react-aria-components";
import { type AutoScrollSettings, DEFAULT_AUTO_SCROLL } from "./auto-scroll";
import {
  BrushCursorOverlay,
  CloneSourceOverlay,
  GradientHandlesOverlay,
  PixelGridOverlay,
  Rulers,
  TextFrameOverlay,
  TransformFrameOverlay,
  WandHandlesOverlay,
  ZoomRectangleOverlay,
} from "./canvas-overlay/CanvasOverlay";
import { LineCurveHandlesOverlay } from "./canvas-overlay/LineCurveHandlesOverlay";
import {
  brushOutlineShape,
  RULER_CSS_PIXELS,
  visibleImageArea,
} from "./canvas-overlay/overlay-math";
import { ShapeHandlesOverlay } from "./canvas-overlay/ShapeHandlesOverlay";
import { canvasScale } from "./canvas-scale";
import { ColorsPanel } from "./colors/ColorsPanel";
import { opfsPaletteStorage } from "./colors/palette-library";
import { PRIMARY_COLOR_PATH, readStoredColor, SECONDARY_COLOR_PATH } from "./colors/use-colors";
import { BUILT_IN_REGISTRY, type BuiltInCommandId } from "./commands/catalog";
import { platformFromName } from "./commands/keys";
import { listenForShortcuts, ShortcutController } from "./commands/shortcuts";
import { type PasteChoice, registerDocumentCommands } from "./edit/document-commands";
import { PasteDialog } from "./edit/PasteDialog";
import { EffectDialogs } from "./effects/EffectDialogs";
import { EffectAwareSelectionOutline, EffectProgress } from "./effects/EffectStatus";
import {
  registerAdjustmentCommands,
  registerEffectCommands,
  registerRotateZoomCommand,
} from "./effects/effect-commands";
import { EffectRuntime } from "./effects/effect-runtime";
import { defaultQualityOf, settingsEffectValues } from "./effects/effect-values";
import { bindEngineDocument, engineSyncPending } from "./engine-document";
import { newDocumentAccountant } from "./errors/memory-budget";
import { ErrorReporter } from "./errors/reporter";
import { installDropTarget } from "./files/drop-target";
import { droppedSources } from "./files/dropped-sources";
import { FileDialogHost } from "./files/FileDialogs";
import { browserFileAccess, type FileAccess } from "./files/file-access";
import { registerFileCommands } from "./files/file-commands";
import { FileDialogs } from "./files/file-dialogs";
import { FileFlows } from "./files/file-flows";
import { consumeLaunchQueue } from "./files/launch-queue";
import { settingsSaveConfig } from "./files/save-config";
import { AboutDialog } from "./help/AboutDialog";
import { InstallNotice } from "./help/InstallViews";
import { InstallHint } from "./help/install-prompt";
import { loadOpenSourceComponents } from "./help/open-source";
import { UpdateNotice } from "./help/UpdateViews";
import { NO_SERVICE_WORKER, UpdateController } from "./help/updates";
import { HistoryPanel } from "./history/HistoryPanel";
import { historyRunning, registerHistoryCommands } from "./history/history-commands";
import { type ImageDialogKind, ImageDialogs } from "./images/ImageDialogs";
import { registerImageDialogCommands } from "./images/image-commands";
import { defaultNewImageSize } from "./images/size-draft";
import { LayerPropertiesDialog } from "./layers/LayerPropertiesDialog";
import { LayersPanel } from "./layers/LayersPanel";
import { registerLayerCommands } from "./layers/layer-commands";
import { useDocumentRevision } from "./layers/use-document-revision";
import { commonActions, type MenuContext, NO_IMAGE_MENU_STATE } from "./menus/menu-model";
import { navigating } from "./navigation";
import { installBenchHook } from "./perf/bench-hook";
import { PERF_FLAGS } from "./perf/flags";
import { perfMonitor } from "./perf/perf-monitor";
import { browserPrinter } from "./print/browser-printer";
import { SessionRestoreDialog } from "./session/SessionRestoreDialog";
import {
  createSessionRecovery,
  SESSION_RECOVERY_PATH,
  type SessionOffer,
  SessionRecoveryToggle,
} from "./session/session-recovery";
import { useCanvasStyle, useOverscroll } from "./settings/canvas-style";
import { diagnosticGroups, diagnosticsText } from "./settings/diagnostics";
import { gatherDiagnosticsFacts } from "./settings/diagnostics-facts";
import {
  PenInputTracker,
  rememberPenInput,
  TOUCH_INPUT_PATH,
  touchInputMode,
} from "./settings/pen-input";
import { useReducedMotionSetting } from "./settings/reduced-motion";
import { SettingsButton } from "./settings/SettingsButton";
import { SettingsDialog } from "./settings/SettingsDialog";
import type { SettingsSection } from "./settings/settings-pages";
import { useAppSettings } from "./settings/use-app-settings";
import { useGraphicsSettings } from "./settings/use-graphics-settings";
import { useSetting } from "./settings/use-setting";
import { AppShell } from "./shell/AppShell";
import { AuxPanelToggles } from "./shell/AuxPanelToggles";
import { CommonActionsBar } from "./shell/CommonActionsBar";
import { CompactMenu } from "./shell/CompactMenu";
import { CompactPanelSheet, PanelSheetButtons } from "./shell/CompactPanelSheet";
import { useDocumentTitle } from "./shell/document-title";
import { HelpMenu } from "./shell/HelpMenu";
import { ImageTabStrip, type ImageTabView } from "./shell/ImageTabStrip";
import { KeyboardShortcuts } from "./shell/KeyboardShortcuts";
import { type MenuActions, MenuBar } from "./shell/MenuBar";
import { MessageDialog } from "./shell/MessageDialog";
import { ModifierBar } from "./shell/ModifierBar";
import {
  effectiveRightWidth,
  PANEL_IDS,
  type PanelId,
  RIGHT_PANEL_IDS,
  RIGHT_SIDEBAR,
  type RightPanelId,
} from "./shell/panel-layout";
import { PANEL_COMMANDS } from "./shell/panel-layout-settings";
import { LeftSidebar, RightSidebar } from "./shell/Sidebars";
import { type ColorSchemePreference, useColorScheme } from "./shell/theme";
import { UnsavedChangesDialog } from "./shell/UnsavedChangesDialog";
import { useCompactLayout, useTouchControls } from "./shell/use-compact-layout";
import { usePanelLayout, useViewportWidth } from "./shell/use-panel-layout";
import { StatusBar } from "./status/StatusBar";
import {
  registerFullScreen,
  registerUnitCommands,
  registerViewCommands,
  registerViewToggles,
} from "./status/status-commands";
import { measureUnit, menuUnitOf } from "./status/status-model";
import { StatusStore } from "./status/status-store";
import { type ClosePlan, closeCandidates, hasUnsavedImages, planClose } from "./tabs/close-flow";
import { createFirstRunImage } from "./tabs/first-run";
import { ImageTabs } from "./tabs/image-tabs";
import { hasUnsavedWork, isBlankImage, type OpenImage } from "./tabs/open-image";
import { registerTabCommands } from "./tabs/tab-commands";
import { ThumbnailCache } from "./tabs/thumbnail-cache";
import { surfaceToDataUrl, TAB_THUMBNAIL_INTERVAL_MS, tabThumbnailUrl } from "./tabs/thumbnail-url";
import { guardUnload } from "./tabs/unload-guard";
import { bundledFontUrls } from "./text/bundled-fonts";
import { startFontPrefetch } from "./text/font-offline";
import { fontCatalog } from "./text/font-store";
import { engineStrokesPending } from "./tools/engine-stroke";
import { engineStrokeChannel } from "./tools/engine-strokes";
import { finishOnLayerSwitch } from "./tools/finish-on-switch";
import { FloatingHandoff, movementToolRuntime } from "./tools/move-tools";
import { builtinToolRuntime, type PaintHost } from "./tools/paint-tools";
import { TOOL_REGISTRY } from "./tools/roster";
import { selectionToolRuntime } from "./tools/select-tools";
import { ToolOptionsStrip } from "./tools/ToolOptionsStrip";
import { ToolsPanel } from "./tools/ToolsPanel";
import { registerToolOptionCommands } from "./tools/tool-commands";
import { ACTIVE_TOOL_PATH, resolveActiveTool, ToolController } from "./tools/tool-controller";
import { bindToolHistory } from "./tools/tool-history";
import { listenForToolKeys } from "./tools/tool-keys";
import { createToolPointerSink } from "./tools/tool-pointer";
import { type ViewHost, viewToolRuntime } from "./tools/view-tools";
import { VirtualModifiers } from "./tools/virtual-modifiers";
import { type CanvasTouchInput, useEngine } from "./useEngine";
import { cpuOffloader, warmCpuOffloader } from "./workers/cpu-offloader";
import { gradientLanes } from "./workers/gradient-lanes";
import { yieldWhileBusy } from "./workers/yield-to-host";

/** SET-LIFE-03: the loading indicator appears only when start-up takes longer than this. */
const LOADING_INDICATOR_DELAY_MS = 300;

/** The colors Fill Selection uses until the Colors panel has stored its own (DOC-COL-01). */
const DEFAULT_PRIMARY: ColorRgba8 = { r: 0, g: 0, b: 0, a: 255 };
const DEFAULT_SECONDARY: ColorRgba8 = { r: 255, g: 255, b: 255, a: 255 };

/** A stored 8-bit color as the 0-1 channels of an effect color property. */
function toUnitColor(color: ColorRgba8): { r: number; g: number; b: number; a: number } {
  return { r: color.r / 255, g: color.g / 255, b: color.b / 255, a: color.a / 255 };
}

/** A paste waiting for the user's answer to the "Paste" prompt (DOC-CLP-05). */
interface PasteRequest {
  readonly image: ClipboardImage;
  readonly answer: (choice: PasteChoice) => void;
}

/** The Color Scheme from the localStorage mirror, which is readable before IndexedDB opens. */
function storedColorScheme(): ColorSchemePreference {
  const stored = readEarlySetting("ui.theme");
  return stored === "Light" || stored === "Dark" ? stored : "Automatic";
}

export interface AppProps {
  /** The error reporter. Main installs it with the global handlers. Tests get an in-memory one. */
  readonly errors?: ErrorReporter | undefined;
  /** Owns the service-worker update state (SET-UPD-01). Omitted in tests and without a worker. */
  readonly updates?: UpdateController | undefined;
  /** Owns the first-run install hint (08 SET-LIFE-01). Main attaches it to the browser's install events. */
  readonly install?: InstallHint | undefined;
  /** The file access for open and save. Omitted to use the browser's (WEB-FILE-01, WEB-FILE-02). */
  readonly files?: FileAccess | undefined;
  /** The Open Recent list (FMT-OPEN-06). Main keeps it in IndexedDB. Tests keep it in memory. */
  readonly recent?: RecentFiles | undefined;
}

export function App({
  updates: suppliedUpdates,
  install: suppliedInstall,
  errors: suppliedErrors,
  files: suppliedFiles,
  recent: suppliedRecent,
}: AppProps) {
  const t = useTranslation();
  /** The name a new image gets, which the blank-image rule checks (`isBlankImage`). */
  const untitled = t("document.untitled");
  const [errors] = useState(
    () =>
      suppliedErrors ??
      new ErrorReporter({
        log: new ErrorLog(new MemoryErrorLogBackend()),
        version: __APP_VERSION__,
        translate: t,
      }),
  );
  const onWorkerError = useCallback(
    (event: ErrorEvent) => {
      void errors.report(event.error ?? event.message, { fatal: true, context: "engine worker" });
    },
    [errors],
  );
  const viewport = useRef<HTMLDivElement>(null);
  const [statusStore] = useState(() => new StatusStore());
  const [floats] = useState(() => new FloatingHandoff());
  const [documentSwitchListeners] = useState(
    () => new Set<(document: Document | undefined) => void>(),
  );
  const engineRef = useRef<EngineHandle | undefined>(undefined);
  const viewHost: ViewHost = {
    view: (command) => void engineRef.current?.view(command),
    zoom: () => statusStore.state.layout?.zoom,
  };
  const [toolController] = useState(
    () =>
      new ToolController({
        registry: TOOL_REGISTRY,
        createRuntime: (tool) =>
          builtinToolRuntime(tool, paintHost) ??
          selectionToolRuntime(tool, paintHost) ??
          movementToolRuntime(tool, paintHost, floats) ??
          viewToolRuntime(tool, viewHost),
      }),
  );
  const [virtualModifiers] = useState(() => new VirtualModifiers());
  const [toolPointer] = useState(() =>
    createToolPointerSink(toolController, historyRunning, () => virtualModifiers.state),
  );
  const [pen] = useState(() => new PenInputTracker());
  const [shortcuts] = useState(
    () =>
      new ShortcutController(
        BUILT_IN_REGISTRY,
        platformFromName(navigator.platform || navigator.userAgent),
      ),
  );
  // One finger draws or pans as Pen & Tablet › Touch input says; a two-finger tap undoes and a
  // three-finger tap redoes.
  const [canvasTouch] = useState<CanvasTouchInput>(() => ({
    mode: () => touchInputMode(settingsRef.current?.get(TOUCH_INPUT_PATH), pen.known),
    tap: (fingers) => {
      if (fingers === 2) shortcuts.invoke("edit.undo");
      else if (fingers === 3) shortcuts.invoke("edit.redo");
    },
  }));
  // The marching ants hold still while a pointer drags on the canvas (L1).
  const autoScrollSettings = useCallback((): AutoScrollSettings => {
    const enabled = settingsRef.current?.get("ui.autoScrollWhileDrawing");
    const speed = settingsRef.current?.get("workspace.autoScrollSpeed");
    return {
      enabled: typeof enabled === "boolean" ? enabled : DEFAULT_AUTO_SCROLL.enabled,
      speed: typeof speed === "number" ? speed : DEFAULT_AUTO_SCROLL.speed,
    };
  }, []);
  const [engineErrorShown, setEngineErrorShown] = useState(false);
  // Errors the engine worker caught or recovered from: logged, and noticed once per session.
  const onEngineError = useCallback(
    (error: EngineError) => {
      console.error("Engine worker:", error.message);
      const cause = Object.assign(new Error(error.message), error);
      void errors.report(cause, { context: "engine worker" });
      setEngineErrorShown(true);
    },
    [errors],
  );
  const [engineErrorDismissed, setEngineErrorDismissed] = useState(false);
  const {
    status,
    engine,
    failed: engineFailed,
  } = useEngine(
    viewport,
    statusStore,
    onWorkerError,
    toolPointer,
    autoScrollSettings,
    onEngineError,
    canvasTouch,
  );
  useEffect(() => {
    engineRef.current = engine;
  }, [engine]);
  const [earlyScheme] = useState(storedColorScheme);
  const [images] = useState(() => new ImageTabs<OpenImage>());
  const tabState = useSyncExternalStore(images.subscribe, () => images.state);
  /** The effect runtime, which is built later, for the checks that run outside React. */
  const effectRuntimeRef = useRef<EffectRuntime | undefined>(undefined);
  const [session] = useState(() =>
    createSessionRecovery(
      (cause) => void errors.report(cause, { context: "session" }),
      newDocumentAccountant,
      () =>
        toolController.editing ||
        navigating() ||
        engineStrokesPending() > 0 ||
        effectRuntimeRef.current?.active === true,
      untitled,
    ),
  );
  const [sessionOffers, setSessionOffers] = useState<readonly SessionOffer[] | undefined>(
    undefined,
  );
  const sessionBegun = useRef(false);
  const [, refreshTabs] = useReducer((count: number) => count + 1, 0);
  /** Thumbnails wait while the user drags on the canvas, moves the view or an effect renders (L8). */
  const [thumbnailsBusy] = useState(
    () => () =>
      toolController.pointerHeld || navigating() || effectRuntimeRef.current?.rendering === true,
  );
  const [thumbnails] = useState(
    () =>
      new ThumbnailCache<Document>({
        render: (doc) => tabThumbnailUrl(doc, yieldWhileBusy(thumbnailsBusy)),
        onChange: refreshTabs,
        intervalMs: TAB_THUMBNAIL_INTERVAL_MS,
        busy: thumbnailsBusy,
      }),
  );
  const activeImage = tabState.items.find((item) => item.id === tabState.activeId)?.value;
  const closeImage = useCallback(
    (id: string) => {
      const item = images.get(id);
      if (item === undefined) return;
      session?.untrack(id);
      images.close(id);
      thumbnails.untrack(id);
      item.value.document.dispose();
    },
    [images, thumbnails, session],
  );
  const [closePrompt, setClosePrompt] = useState<ClosePlan | undefined>(undefined);
  /** True while the Unsaved Changes prompt stands between the user and an update reload. */
  const reloadAfterClose = useRef(false);
  const [updates] = useState(
    () =>
      suppliedUpdates ??
      new UpdateController(NO_SERVICE_WORKER, { isOnline: () => navigator.onLine }),
  );
  useEffect(() => updates.start(), [updates]);
  const [install] = useState(() => suppliedInstall ?? new InstallHint({ installed: true }));
  const [aboutOpen, setAboutOpen] = useState(false);
  /** A message for the user, from a failed link or a refused reload. */
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const closeImages = useCallback(
    (ids: readonly string[]) => {
      for (const id of ids) closeImage(id);
      setClosePrompt(undefined);
    },
    [closeImage],
  );
  const requestClose = useCallback(
    (ids: readonly string[]) => {
      const plan = planClose(
        closeCandidates(
          images.state.items.filter((item) => ids.includes(item.id)),
          untitled,
        ),
      );
      if (plan.dirty.length === 0) closeImages(plan.ids);
      else setClosePrompt(plan);
    },
    [images, closeImages, untitled],
  );
  useEffect(
    () =>
      guardUnload(window, () => hasUnsavedImages(closeCandidates(images.state.items, untitled))),
    [images, untitled],
  );
  /**
   * The default blank image the app opens when it starts with nothing to show (owner request), or
   * undefined once it has been changed, closed or replaced.
   */
  const startImageId = useRef<string | undefined>(undefined);
  const openStartImage = useCallback(() => {
    if (images.state.items.length > 0) return;
    startImageId.current = images.open(createFirstRunImage(untitled));
  }, [images, untitled]);
  /**
   * Closes the start image when it is still untouched, so files the app was launched with take its
   * place instead of opening beside it.
   */
  const replaceStartImage = useCallback(() => {
    const id = startImageId.current;
    startImageId.current = undefined;
    const start = images.state.items.find((item) => item.id === id);
    if (start === undefined) return;
    if (isBlankImage(start.value, untitled)) closeImages([start.id]);
  }, [images, closeImages, untitled]);
  useEffect(() => {
    if (session === undefined) return;
    for (const item of tabState.items) session.track(item.id, item.value);
    session.retain(tabState.items.map((item) => item.id));
  }, [session, tabState]);
  /**
   * Reloads onto a waiting update (SET-LIFE-06, SET-UPD-04). Unsaved images get the Unsaved Changes
   * prompt first, and the reload waits for it, so an update never discards work by itself.
   */
  const applyUpdate = useCallback(() => {
    if (closePrompt !== undefined) {
      setNotice(t("reload.blocked"));
      return;
    }
    const plan = planClose(closeCandidates(images.state.items, untitled));
    if (plan.dirty.length === 0) {
      if (session === undefined) updates.applyUpdate();
      else void session.flush().finally(() => updates.applyUpdate());
      return;
    }
    reloadAfterClose.current = true;
    setClosePrompt(plan);
  }, [closePrompt, images, session, t, updates, untitled]);
  /**
   * Reloads after the engine could not start. Open images cannot be shown without it. With session
   * recovery on, the session is flushed first so it offers them again; either way the browser's
   * leave-page prompt asks first while any image has unsaved work.
   */
  const reloadPage = useCallback(() => {
    const reload = () => window.location.reload();
    if (session === undefined) reload();
    else void session.flush().finally(reload);
  }, [session]);
  /** Closes the images of an answered Unsaved Changes prompt, then applies a waiting update reload. */
  const finishClose = useCallback(
    (ids: readonly string[]) => {
      closeImages(ids);
      if (reloadAfterClose.current) {
        reloadAfterClose.current = false;
        updates.applyUpdate();
      }
    },
    [closeImages, updates],
  );
  const settings = useAppSettings();
  useEffect(() => toolController.attach(settings), [toolController, settings]);
  const [recoveryToggle] = useState(() =>
    session === undefined
      ? undefined
      : new SessionRecoveryToggle(
          session,
          (offers) => {
            if (offers.length > 0) setSessionOffers(offers);
            else openStartImage();
          },
          (cause) => void errors.report(cause, { context: "session" }),
        ),
  );
  const sessionRecoveryOn = useSetting(settings, SESSION_RECOVERY_PATH) === true;
  /**
   * Once settings are read, session recovery follows its setting (owner request: off by default).
   * On at start, the checkpoints of earlier sessions are offered once; off, they are deleted and the
   * app opens the default blank image. Turning it on or off later starts or stops checkpointing.
   */
  useEffect(() => {
    if (settings === null) return;
    if (recoveryToggle === undefined) {
      if (!sessionBegun.current) openStartImage();
    } else {
      recoveryToggle.apply(sessionRecoveryOn);
    }
    sessionBegun.current = true;
  }, [settings, recoveryToggle, sessionRecoveryOn, openStartImage]);
  const firstRunHandled = useRef(false);
  useEffect(() => {
    if (settings === null || firstRunHandled.current) return;
    firstRunHandled.current = true;
    if (!settings.persistent) setNotice(t("settings.notPersistent"));
    if (settings.get("app.firstRunCompleted") !== true) {
      openStartImage();
      install.beginFirstRun();
      settings.set("app.firstRunCompleted", true);
      settings.set("app.lastRunVersion", __APP_VERSION__);
      return;
    }
    if (settings.get("app.lastRunVersion") !== __APP_VERSION__) {
      settings.set("app.lastRunVersion", __APP_VERSION__);
    }
  }, [settings, install, t, openStartImage]);
  const [loadingSlow, setLoadingSlow] = useState(false);
  useEffect(() => {
    if (settings !== null) return undefined;
    const timer = setTimeout(() => setLoadingSlow(true), LOADING_INDICATOR_DELAY_MS);
    return () => clearTimeout(timer);
  }, [settings]);
  const themeSetting = useSetting(settings, "ui.theme");
  useColorScheme(
    themeSetting === "Light" || themeSetting === "Dark" || themeSetting === "Automatic"
      ? themeSetting
      : earlyScheme,
  );
  useReducedMotionSetting(settings);
  const animations = useSetting(settings, "ui.animations") !== false;
  useEffect(() => {
    document.documentElement.dataset.animations = animations ? "on" : "off";
  }, [animations]);
  useCanvasStyle(engine, settings);
  useOverscroll(engine, settings);
  useGraphicsSettings(settings, status);
  const [sessionStart] = useState(() => new Date());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("ui");
  const openSettings = (section: SettingsSection = settingsSection) => {
    setSettingsSection(section);
    setSettingsOpen(true);
  };
  const viewErrorLog = () => openSettings("diagnostics");
  useEffect(() => {
    pen.start(window);
    return () => pen.stop();
  }, [pen]);
  useEffect(
    () => (settings === null ? undefined : rememberPenInput(pen, settings)),
    [pen, settings],
  );
  useEffect(
    () => shortcuts.register("edit.settings", { run: () => setSettingsOpen(true) }),
    [shortcuts],
  );
  const units = measureUnit(useSetting(settings, "workspace.measurementUnit"));
  const showPixelGrid = useSetting(settings, "workspace.showPixelGrid") === true;
  const showRulers = useSetting(settings, "workspace.showRulers") === true;
  const antialiasedOutline = useSetting(settings, "ui.antialiasedSelectionOutline") !== false;
  const [fullScreen, setFullScreen] = useState(false);
  useEffect(() => {
    const sync = () => setFullScreen(document.fullscreenElement !== null);
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  const activeTool = resolveActiveTool(TOOL_REGISTRY, useSetting(settings, ACTIVE_TOOL_PATH));
  const brushSize = useSetting(settings, "tools.brush.size");
  const brushTipShape = brushOutlineShape(useSetting(settings, "tools.brush.type"));
  const brushOutline =
    (activeTool.id === "paintbrush" ||
      activeTool.id === "eraser" ||
      activeTool.id === "recolor" ||
      activeTool.id === "cloneStamp") &&
    typeof brushSize === "number"
      ? brushSize
      : undefined;
  useEffect(() => {
    statusStore.setHint({ text: t(activeTool.help) });
  }, [activeTool, statusStore, t]);
  const [paletteStorage] = useState(() => opfsPaletteStorage());
  const panels = usePanelLayout(settings);
  const panelsReady = settings !== null;
  const viewportWidth = useViewportWidth();
  const canvasArea = useRef<HTMLElement>(null);
  const returnFocusToCanvas = useCallback(() => canvasArea.current?.focus(), []);
  const compactLayout = useCompactLayout();
  const compactRef = useRef(compactLayout.compact);
  compactRef.current = compactLayout.compact;
  const touchControls = useTouchControls();
  /** The compact layout's panel sheet and tool rail; the docked layout's settings stay as saved. */
  const [sheetPanel, setSheetPanel] = useState<RightPanelId | undefined>(undefined);
  const [railHidden, setRailHidden] = useState(false);
  const toggleCompactPanel = useCallback((panel: PanelId) => {
    if (panel === "tools") setRailHidden((hidden) => !hidden);
    else setSheetPanel((open) => (open === panel ? undefined : panel));
  }, []);
  const finishTool = useCallback(() => {
    toolController.runtime()?.commit?.();
    returnFocusToCanvas();
  }, [toolController, returnFocusToCanvas]);
  /** Canvas navigation keys act only while focus is on the canvas, not in a panel (UI-KEY-02). */
  const canvasHasFocus = useCallback(() => {
    const active = document.activeElement;
    return (
      active === null || active === document.body || (canvasArea.current?.contains(active) ?? false)
    );
  }, []);
  const [helpOpen, setHelpOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [layerPropertiesOpen, setLayerPropertiesOpen] = useState(false);
  const [imageDialog, setImageDialog] = useState<ImageDialogKind | undefined>(undefined);
  const [clipboard] = useState(() => new ClipboardService(browserClipboard(), browserCodecs()));
  /** True once the clipboard was found empty, until the window regains focus (UI-MENU-EDIT). */
  const [clipboardEmpty, setClipboardEmpty] = useState(false);
  useEffect(() => {
    const reset = () => setClipboardEmpty(false);
    window.addEventListener("focus", reset);
    return () => window.removeEventListener("focus", reset);
  }, []);
  const [pasteRequest, setPasteRequest] = useState<PasteRequest | undefined>(undefined);
  const askPasteChoice = useCallback(
    (image: ClipboardImage) =>
      new Promise<PasteChoice>((resolve) => {
        setPasteRequest({
          image,
          answer: (choice) => {
            setPasteRequest(undefined);
            resolve(choice);
          },
        });
      }),
    [],
  );
  const settingsRef = useRef(settings);
  const gpuEffectsRef = useRef<EngineGpuOffloader | undefined>(undefined);
  const paintHost: PaintHost = {
    settings: () => settingsRef.current,
    document: () => images.active?.value.document,
    onDocumentSwitch: (listener) => {
      documentSwitchListeners.add(listener);
      return () => {
        documentSwitchListeners.delete(listener);
      };
    },
    translate: t,
    notify: (messageId) => setNotice(t(messageId)),
    report: (cause) => void errors.report(cause, { context: "paint tool" }),
    status: (text) => statusStore.setHint({ text }),
    activateTool: (id) => {
      toolController.activate(id);
    },
    previousTool: () => toolController.previous,
    scheduleFrame: (callback) => {
      const id = requestAnimationFrame(callback);
      return () => cancelAnimationFrame(id);
    },
    engineStrokes: () =>
      engineStrokeChannel(
        engineRef.current,
        (cause) => void errors.report(cause, { context: "paint tool" }),
      ),
    gradientLanes,
    visibleArea: () => visibleImageArea(statusStore.state.layout, viewport.current),
    transformResampler: () => {
      const gpu = gpuEffectsRef.current;
      return gpu?.canTransform === true
        ? (source, spec, signal) => gpu.transform(source, spec, signal)
        : undefined;
    },
    floatDisplay: (session) => ({
      available: () => {
        const handle = engineRef.current;
        const document = images.active?.value.document;
        if (handle === undefined || document === undefined) return false;
        const layers = document.layers.map(({ visible, opacity, blendMode }) => ({
          visible,
          opacity,
          mode: blendMode,
        }));
        return engineShowsFloat(
          handle.status,
          layers,
          document.layers.indexOf(session.layer),
          session.size,
          document,
        );
      },
    }),
    floatComposer: () => (job) => cpuOffloader().composeFloating(job),
  };
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useEffect(() => {
    void fontCatalog.start();
    startFontPrefetch(bundledFontUrls(), thumbnailsBusy);
  }, [thumbnailsBusy]);
  const [registry] = useState(() =>
    builtinFileTypeRegistry({
      embedBmpColorProfiles: () => settingsRef.current?.get("fileTypes.bmpColorProfiles") === true,
      memoryBudgetBytes: () => newDocumentAccountant().budgetBytes,
    }),
  );
  const [access] = useState<FileAccess>(() => suppliedFiles ?? browserFileAccess());
  const [recent] = useState(
    () => suppliedRecent ?? new RecentFiles(new MemoryRecentFilesBackend()),
  );
  const recentEntries = useSyncExternalStore(recent.subscribe, () => recent.entries);
  const [fileDialogs] = useState(() => new FileDialogs());
  /** Opens a file's image as a tab and fits the view, the same as a new image does. */
  const openImageTab = useRef<(image: OpenImage) => void>(() => undefined);
  useEffect(() => {
    openImageTab.current = (image) => {
      images.open(image);
      void engine?.view({ type: "fit" });
    };
  }, [images, engine]);
  const [fileFlows] = useState(
    () =>
      new FileFlows({
        registry,
        access,
        dialogs: fileDialogs,
        recent,
        saveConfig: settingsSaveConfig(() => settingsRef.current),
        tabs: images,
        t,
        openImage: (image) => openImageTab.current(image),
        thumbnail: (document, maxSize) => surfaceToDataUrl(documentThumbnail(document, maxSize)),
        devicePixelRatio: () => window.devicePixelRatio,
        printer: browserPrinter,
        newImageSize: () =>
          defaultNewImageSize({
            screen: { width: window.screen.width, height: window.screen.height },
            devicePixelRatio: window.devicePixelRatio,
          }),
        notify: (text) => setNotice(text),
        report: (cause) => void errors.report(cause, { context: "file" }),
        finishPending: (document) => {
          if (document === images.active?.value.document) toolController.finishBeforeChange();
        },
      }),
  );
  useEffect(() => {
    errors.setDiagnostics(async () => {
      const facts = await gatherDiagnosticsFacts({
        version: __APP_VERSION__,
        buildDate: __APP_BUILD_DATE__,
        update: { state: updates.snapshot.state, lastCheck: updates.lastCheckedAt },
        sessionStart,
        status,
        penDetected: pen.detected,
        animations,
        workerPolicy: String(settings?.get("performance.workerPolicy") ?? "ThreeQuarters"),
        fileCodecs: fileFlows.unavailableCodecs(),
      });
      return diagnosticsText(diagnosticGroups(facts, t), `${t("app.name")} ${__APP_VERSION__}`);
    });
  }, [errors, updates, sessionStart, status, pen, animations, settings, t, fileFlows]);
  const openDocument = useCallback(
    (document: Document) => {
      images.open({ name: t("document.untitled"), document });
      void engine?.view({ type: "fit" });
    },
    [images, engine, t],
  );
  const restoreSession = useCallback(
    async (offers: readonly SessionOffer[]) => {
      setSessionOffers(undefined);
      if (session === undefined) return;
      for (const offer of offers) {
        try {
          const restored = await session.restore(offer);
          const image = { name: restored.name, document: restored.document };
          session.track(images.open(image), image, restored.key);
        } catch (cause) {
          void errors.report(cause, { context: "session" });
        }
      }
      void engine?.view({ type: "fit" });
    },
    [session, images, engine, errors],
  );
  /**
   * Discards the offered checkpoints and, when no image is open, opens the default blank image the
   * first run shows, so the app never sits empty after a discard (owner request).
   */
  const discardSession = useCallback(
    (offers: readonly SessionOffer[]) => {
      setSessionOffers(undefined);
      session
        ?.discard(offers)
        .catch((cause: unknown) => void errors.report(cause, { context: "session" }));
      if (images.state.items.length === 0) {
        openStartImage();
        void engine?.view({ type: "fit" });
      }
    },
    [session, errors, images, engine, openStartImage],
  );
  const readColor = useCallback(
    (path: string, fallback: ColorRgba8) =>
      settings === null ? fallback : readStoredColor(settings, path, fallback),
    [settings],
  );
  const autoSelectNearest = useCallback(
    () => settings?.get("ui.autoSelectNearestVisibleLayer") === true,
    [settings],
  );
  const factoryQuality = status?.performanceClass === "Good" ? 2 : 1;
  const backend = status?.backend === "webgpu" ? "gpu" : "cpu";
  const defaultQuality = defaultQualityOf(settings, backend === "gpu", factoryQuality);
  const effects = useMemo(() => {
    const registry = new EffectRegistry();
    registerBuiltinEffects(registry, factoryQuality, defaultQuality);
    return registry;
  }, [factoryQuality, defaultQuality]);
  // Effects run their WGSL twins on the engine's own device (one device per app, WEB-GPU-01).
  const gpuEffects = useMemo(
    () =>
      engine === undefined
        ? undefined
        : new EngineGpuOffloader(engine, () => engine.status.backend === "webgpu"),
    [engine],
  );
  useEffect(() => {
    gpuEffectsRef.current = gpuEffects;
  }, [gpuEffects]);
  const effectRuntime = useMemo(
    () =>
      new EffectRuntime({
        registry: effects,
        bindings: builtinEffectBindings(factoryQuality, defaultQuality),
        memory: new EffectMemory(settingsEffectValues(settings)),
        document: () => images.active?.value.document,
        translate: t,
        backend: () => backend,
        offload: cpuOffloader(),
        gpu: gpuEffects,
        visibleArea: () => visibleImageArea(statusStore.state.layout, viewport.current),
        // Both engines draw layer live filters, so adjustments preview without writing the layer.
        liveFilters: true,
        scheduleFrame: (callback) => {
          const id = requestAnimationFrame(callback);
          return () => cancelAnimationFrame(id);
        },
        log: (message, cause) => void errors.report(cause, { context: message }),
        beforeStart: () => toolController.finishBeforeChange(),
        colors: () => ({
          primary: toUnitColor(readColor(PRIMARY_COLOR_PATH, DEFAULT_PRIMARY)),
          secondary: toUnitColor(readColor(SECONDARY_COLOR_PATH, DEFAULT_SECONDARY)),
        }),
      }),
    [
      effects,
      factoryQuality,
      defaultQuality,
      backend,
      gpuEffects,
      statusStore,
      settings,
      images,
      t,
      errors,
      readColor,
      toolController,
    ],
  );
  useEffect(() => {
    effectRuntimeRef.current = effectRuntime;
  }, [effectRuntime]);
  // Only the Repeat item reads the runtime here; the progress and the outline tint subscribe on
  // their own, so a preview's progress does not re-render the app (L3).
  const lastEffectId = useSyncExternalStore(
    effectRuntime.subscribe,
    () => effectRuntime.lastEffectId,
  );
  useEffect(() => (engine === undefined ? undefined : perfMonitor?.attachEngine(engine)), [engine]);
  useEffect(
    () =>
      perfMonitor?.addIdleCheck(() => {
        if (effectRuntime.rendering) return "effect render";
        if (session?.saving === true) return "session checkpoint";
        if (engineStrokesPending() > 0) return "engine stroke";
        if (engineSyncPending()) return "engine sync";
        try {
          // Throws while an undo or redo runs or a background job (a resize) holds the document.
          images.active?.value.document.history.assertIdle();
          return true;
        } catch {
          return "history";
        }
      }),
    [images, effectRuntime, session],
  );
  useEffect(() => {
    if (!PERF_FLAGS.bench) return undefined;
    return installBenchHook(window, {
      open: openDocument,
      accountant: newDocumentAccountant,
      setSetting: (path, value) => settingsRef.current?.set(path, value),
      status: () => status,
      layout: () => statusStore.state.layout,
      document: () => images.active?.value.document,
    });
  }, [openDocument, status, statusStore, images]);
  const hasDocument = activeImage !== undefined;
  const activeDocument = activeImage?.document;
  useDocumentRevision(activeDocument);
  useEffect(
    () => (engine === undefined ? undefined : bindEngineDocument(engine, activeDocument)),
    [engine, activeDocument],
  );
  // A pending tool result is finished on its own layer when another layer or image becomes active,
  // so the next gesture acts on the new one (TL-FRAME-01).
  useEffect(() => {
    if (activeDocument === undefined) return undefined;
    const stop = finishOnLayerSwitch(activeDocument, () => toolController.finishPending());
    // Undo and redo take tools and layers back to their results, which stay editable (TL-FRAME-01).
    const stopFollowing = bindToolHistory(activeDocument, toolController, (cause) => {
      void errors.report(cause, { context: "tool history" });
    });
    // A command finishes a pending result before it changes the image.
    const stopGuard = activeDocument.setChangeGuard(() => toolController.finishBeforeChange());
    return () => {
      stop();
      stopFollowing();
      stopGuard();
      if (images.state.items.some((item) => item.value.document === activeDocument)) {
        toolController.finishPending();
      }
    };
  }, [activeDocument, images, toolController, errors]);
  // The active tool follows the newly active image, such as the move tools' handles.
  useEffect(() => {
    for (const listener of [...documentSwitchListeners]) listener(activeDocument);
  }, [activeDocument, documentSwitchListeners]);
  const selected = activeDocument !== undefined && !activeDocument.selection.isEmpty;
  // Once something is selected, the worker for Move Selected Pixels commits loads at idle.
  useEffect(() => (selected ? warmCpuOffloader() : undefined), [selected]);
  const activeLayer = activeDocument?.activeLayer;
  const activeLayerIndex =
    activeDocument !== undefined && activeLayer !== undefined
      ? activeDocument.layers.indexOf(activeLayer)
      : 0;
  useDocumentTitle(
    activeImage === undefined
      ? null
      : { path: activeImage.name, dirty: hasUnsavedWork(activeImage, untitled) },
    t,
  );
  const menuContext: MenuContext = {
    toolAcceptsPaste: () => toolController.acceptsPaste(),
    state: {
      ...NO_IMAGE_MENU_STATE,
      hasDocument,
      canUndo: activeDocument?.history.canUndo === true,
      canRedo: activeDocument?.history.canRedo === true,
      hasSelection: activeDocument !== undefined && !activeDocument.selection.isEmpty,
      saveAsOffered: access.canPickSaveTarget,
      clipboardHasImage: !clipboardEmpty,
      clipboardHasSelection: !clipboardEmpty,
      activeLayerIsBitmap: hasDocument,
      layerCount: activeDocument?.layerCount ?? 0,
      activeLayerIndex,
      canRunEffects: hasDocument,
      anyUnsaved: hasUnsavedImages(closeCandidates(tabState.items, untitled)),
      recent: recentEntries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        thumbnail: entry.thumbnail,
      })),
      lastEffectId,
      view: {
        ...NO_IMAGE_MENU_STATE.view,
        units: menuUnitOf(units),
        pixelGrid: showPixelGrid,
        rulers: showRulers,
        fullScreen,
      },
      fullScreenAvailable: document.fullscreenEnabled,
    },
    effects,
    commands: shortcuts,
    t,
  };
  const menuActions: MenuActions = useMemo(
    () => ({
      onCommand: (id: BuiltInCommandId) => shortcuts.invoke(id),
      onEffect: (id: string) => effectRuntime.start(id),
      onRecent: (id: number) => fileFlows.run(() => fileFlows.openRecent(id)),
    }),
    [shortcuts, effectRuntime, fileFlows],
  );
  // The strip shows enable states outside a menu, so it reads them again when a command attaches.
  useSyncExternalStore(shortcuts.subscribe, () => shortcuts.version);
  const commonEntries = commonActions(menuContext);
  const runCommonAction = useCallback(
    (id: BuiltInCommandId) => {
      shortcuts.invoke(id);
    },
    [shortcuts],
  );
  useEffect(() => listenForShortcuts(shortcuts), [shortcuts]);
  useEffect(() => registerEffectCommands(shortcuts, effectRuntime), [shortcuts, effectRuntime]);
  useEffect(() => registerRotateZoomCommand(shortcuts, effectRuntime), [shortcuts, effectRuntime]);
  useEffect(
    () => registerAdjustmentCommands(shortcuts, effectRuntime, effects),
    [shortcuts, effectRuntime, effects],
  );
  useEffect(
    () =>
      registerViewCommands(
        shortcuts,
        engine,
        hasDocument,
        canvasHasFocus,
        () => statusStore.state.layout?.mode !== "fixed",
      ),
    [shortcuts, engine, hasDocument, canvasHasFocus, statusStore],
  );
  useEffect(
    () => registerViewToggles(shortcuts, settings, hasDocument),
    [shortcuts, settings, hasDocument],
  );
  useEffect(() => registerUnitCommands(shortcuts, settings), [shortcuts, settings]);
  useEffect(() => registerFullScreen(shortcuts, document), [shortcuts]);
  useEffect(
    () => registerToolOptionCommands(shortcuts, toolController),
    [shortcuts, toolController],
  );
  useEffect(
    () =>
      listenForToolKeys(window, {
        controller: toolController,
        canvasHasFocus,
        canDeselect: () => shortcuts.isEnabled("edit.deselect"),
        deselect: () => shortcuts.invoke("edit.deselect"),
        // A pan moves the content with it, so the view scrolls opposite to the arrow (as in useEngine).
        scrollView: (dx, dy) =>
          void engineRef.current?.view({
            type: "pan",
            dx: -dx * canvasScale.value,
            dy: -dy * canvasScale.value,
          }),
      }),
    [toolController, canvasHasFocus, shortcuts],
  );
  useEffect(() => {
    const detach = [
      shortcuts.register("help.openMenu", { run: () => setHelpOpen(true) }),
      shortcuts.register("help.keyboardShortcuts", { run: () => setShortcutsOpen(true) }),
      shortcuts.register("help.about", { run: () => setAboutOpen(true) }),
    ];
    return () => {
      for (const release of detach) release();
    };
  }, [shortcuts]);
  useEffect(
    () => registerTabCommands(shortcuts, images, requestClose),
    [shortcuts, images, requestClose],
  );
  useEffect(
    () => registerHistoryCommands(shortcuts, () => images.active?.value.document),
    [shortcuts, images],
  );
  useEffect(
    () =>
      registerLayerCommands(shortcuts, {
        document: () => images.active?.value.document,
        openProperties: () => setLayerPropertiesOpen(true),
        autoSelectNearest,
      }),
    [shortcuts, images, autoSelectNearest],
  );
  useEffect(
    () =>
      registerImageDialogCommands(shortcuts, {
        hasDocument: () => images.active !== undefined,
        open: setImageDialog,
      }),
    [shortcuts, images],
  );
  useEffect(
    () =>
      registerDocumentCommands(shortcuts, {
        document: () => images.active?.value.document,
        clipboard,
        primary: () => readColor(PRIMARY_COLOR_PATH, DEFAULT_PRIMARY),
        secondary: () => readColor(SECONDARY_COLOR_PATH, DEFAULT_SECONDARY),
        askPasteChoice,
        openDocument,
        pasteText: (text) => toolController.pasteText(text),
        floatPaste: (document, image, at, options) => {
          // A pending result of the move tool is committed before the paste changes the layer.
          const runtime = toolController.runtime();
          if (runtime?.hasPending?.()) runtime.commit?.();
          floats.offer(document.pasteFloating(image, at, options));
          toolController.activate("moveSelectedPixels");
        },
        zoomToArea: (area) => void engine?.view({ type: "zoomToRect", ...area }),
        notify: (messageId) => setNotice(t(messageId)),
        setClipboardEmpty,
        report: (cause) => void errors.report(cause, { context: "edit command" }),
      }),
    [
      shortcuts,
      images,
      clipboard,
      readColor,
      askPasteChoice,
      openDocument,
      engine,
      t,
      errors,
      floats,
      toolController,
    ],
  );
  useEffect(
    () =>
      registerFileCommands(shortcuts, {
        flows: fileFlows,
        hasImage: () => images.active !== undefined,
        hasUnsaved: () => hasUnsavedImages(closeCandidates(images.state.items, untitled)),
        hasRecent: () => recent.entries.length > 0,
      }),
    [shortcuts, fileFlows, images, recent, untitled],
  );
  useEffect(
    () =>
      installDropTarget(window, (data) => {
        const sources = droppedSources(data);
        fileFlows.run(() => fileFlows.dropped(sources));
      }),
    [fileFlows],
  );
  useEffect(
    () =>
      consumeLaunchQueue(window, (handles) => {
        replaceStartImage();
        fileFlows.run(() => fileFlows.openHandles(handles));
      }),
    [fileFlows, replaceStartImage],
  );
  useEffect(() => {
    thumbnails.sync(new Map(tabState.items.map((item) => [item.id, item.value.document])));
  }, [tabState.items, thumbnails]);
  useEffect(() => {
    if (!panelsReady) return undefined;
    const detach = PANEL_IDS.map((panel) =>
      shortcuts.register(PANEL_COMMANDS[panel], {
        run: () => {
          // The compact layout's rail and sheet are its own; the docked layout stays as saved.
          if (compactRef.current) toggleCompactPanel(panel);
          else panels.actions.toggleVisible(panel);
          returnFocusToCanvas();
        },
      }),
    );
    return () => {
      for (const release of detach) release();
    };
  }, [panelsReady, panels.actions, shortcuts, returnFocusToCanvas, toggleCompactPanel]);
  useEffect(() => () => thumbnails.dispose(), [thumbnails]);
  const tabViews: ImageTabView[] = tabState.items.map((item) => ({
    id: item.id,
    title: item.value.name,
    dirty: hasUnsavedWork(item.value, untitled),
    busy: false,
    thumbnail: thumbnails.url(item.id),
    size: { width: item.value.document.width, height: item.value.document.height },
  }));
  const { layout } = panels;
  const rightWidth = effectiveRightWidth(layout.rightSidebarWidth, viewportWidth);
  const rightVisible = RIGHT_PANEL_IDS.some((panel) => layout.visible[panel]);
  const togglePanel = (panel: PanelId) => {
    panels.actions.toggleVisible(panel);
    returnFocusToCanvas();
  };
  const { compact } = compactLayout;
  const toolsPanel = (
    <ToolsPanel
      tools={TOOL_REGISTRY.list()}
      activeId={activeTool.id}
      onSelect={(id) => {
        toolController.activate(id);
        returnFocusToCanvas();
      }}
    />
  );
  const colorsPanel = (setExpanded: (expanded: boolean) => void) =>
    settings === null ? null : (
      <ColorsPanel
        settings={settings}
        storage={paletteStorage}
        commands={shortcuts}
        expanded={layout.colorsExpanded}
        onExpandedChange={setExpanded}
        onRelinquish={returnFocusToCanvas}
      />
    );
  const layersPanel = (
    <LayersPanel
      doc={activeImage?.document}
      commands={shortcuts}
      autoSelectNearest={autoSelectNearest}
      thumbnailsBusy={thumbnailsBusy}
    />
  );
  const historyPanel = <HistoryPanel doc={activeImage?.document} commands={shortcuts} />;
  const undoRedoEntries = commonEntries.filter(
    (entry) => entry.kind === "action" && (entry.id === "edit.undo" || entry.id === "edit.redo"),
  );
  return (
    <AppShell
      layout={compactLayout}
      compactStart={
        compact ? (
          <>
            <CompactMenu context={menuContext} actions={menuActions} />
            <CommonActionsBar entries={undoRedoEntries} onCommand={runCommonAction} />
          </>
        ) : undefined
      }
      compactEnd={
        compact ? (
          <PanelSheetButtons open={sheetPanel} onToggle={(panel) => toggleCompactPanel(panel)} />
        ) : undefined
      }
      sheet={
        compact && sheetPanel !== undefined ? (
          <CompactPanelSheet
            panel={sheetPanel}
            onSelect={setSheetPanel}
            onClose={() => {
              setSheetPanel(undefined);
              returnFocusToCanvas();
            }}
            colors={colorsPanel((expanded) => panels.actions.setColorsExpanded(expanded))}
            layers={layersPanel}
            history={historyPanel}
          />
        ) : undefined
      }
      canvasRef={canvasArea}
      commonActions={<CommonActionsBar entries={commonEntries} onCommand={runCommonAction} />}
      toolOptions={
        settings === null ? undefined : (
          <ToolOptionsStrip
            tool={activeTool}
            settings={settings}
            gpuPerformanceClass={status?.performanceClass ?? "VeryLow"}
            onFinish={finishTool}
            onSelectTool={(id) => toolController.activate(id)}
            pen={pen}
            hasSelection={menuContext.state.hasSelection}
          />
        )
      }
      rightSidebarWidth={rightWidth}
      leftSidebar={
        panelsReady && (compact ? !railHidden : layout.visible.tools) ? (
          <LeftSidebar onRelinquish={returnFocusToCanvas} tools={toolsPanel} />
        ) : undefined
      }
      rightSidebar={
        panelsReady && rightVisible && !compact ? (
          <RightSidebar
            layout={layout}
            actions={panels.actions}
            width={rightWidth}
            widthResizable={viewportWidth >= RIGHT_SIDEBAR.narrowViewport}
            onRelinquish={returnFocusToCanvas}
            colors={colorsPanel}
            layers={layersPanel}
            history={historyPanel}
          />
        ) : undefined
      }
      menuBar={
        <>
          <MenuBar context={menuContext} actions={menuActions} />
          <div className="app-aux">
            <AuxPanelToggles layout={layout} commands={shortcuts} onToggle={togglePanel} />
            <SettingsButton commands={shortcuts} onOpen={() => openSettings()} />
            <HelpMenu
              isOpen={helpOpen}
              onOpenChange={setHelpOpen}
              context={menuContext}
              actions={menuActions}
            />
          </div>
        </>
      }
      statusBar={
        <StatusBar
          store={statusStore}
          doc={activeDocument}
          units={units}
          commands={shortcuts}
          onZoom={(ratio) => void engine?.view({ type: "zoom", ratio })}
        />
      }
      imageTabs={
        // The compact layout shows the strip only once a second image is open.
        compact && tabViews.length < 2 ? undefined : (
          <ImageTabStrip
            tabs={tabViews}
            activeId={tabState.activeId}
            commands={shortcuts}
            onActivate={(id) => images.activate(id)}
            onClose={(id) => requestClose([id])}
            onMove={(id, index) => images.move(id, index)}
            saveAsOffered={access.canPickSaveTarget}
          />
        )
      }
    >
      {touchControls && <ModifierBar modifiers={virtualModifiers} />}
      <KeyboardShortcuts
        isOpen={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        registry={BUILT_IN_REGISTRY}
        platform={shortcuts.platform}
      />
      <LayerPropertiesDialog
        doc={activeImage?.document}
        isOpen={layerPropertiesOpen}
        onClose={() => setLayerPropertiesOpen(false)}
      />
      <ImageDialogs
        kind={imageDialog}
        doc={activeDocument}
        settings={settings}
        onClose={() => setImageDialog(undefined)}
        onCreate={openDocument}
      />
      <PasteDialog
        image={pasteRequest?.image}
        onChoose={(choice) => pasteRequest?.answer(choice)}
      />
      {closePrompt !== undefined && (
        <UnsavedChangesDialog
          images={closePrompt.dirty.flatMap((id) => {
            const item = images.get(id);
            return item === undefined
              ? []
              : [{ id, name: item.value.name, thumbnail: thumbnails.url(id) }];
          })}
          onSave={() =>
            fileFlows.run(async () => {
              if (await fileFlows.saveImages(closePrompt.dirty)) finishClose(closePrompt.ids);
            })
          }
          onDiscard={() => finishClose(closePrompt.ids)}
          onCancel={() => {
            reloadAfterClose.current = false;
            setClosePrompt(undefined);
          }}
          onActivate={(id) => images.activate(id)}
        />
      )}
      {sessionOffers !== undefined && (
        <SessionRestoreDialog
          offers={sessionOffers}
          onRestore={() => void restoreSession(sessionOffers)}
          onDiscard={() => discardSession(sessionOffers)}
        />
      )}
      <FileDialogHost dialogs={fileDialogs} />
      <EffectDialogs runtime={effectRuntime} onViewErrorLog={viewErrorLog} />
      <SettingsDialog
        isOpen={settingsOpen && settings !== null}
        section={settingsSection}
        settings={settings}
        engine={engine}
        status={status}
        pen={pen}
        version={__APP_VERSION__}
        sessionStart={sessionStart}
        errors={errors}
        updates={updates}
        onReloadUpdate={applyUpdate}
        onClose={() => setSettingsOpen(false)}
      />
      <AboutDialog
        isOpen={aboutOpen}
        version={__APP_VERSION__}
        buildDate={__APP_BUILD_DATE__}
        loadComponents={loadOpenSourceComponents}
        updates={updates}
        onReload={applyUpdate}
        onClose={() => setAboutOpen(false)}
      />
      {notice !== undefined && (
        <MessageDialog
          isOpen
          title={t("app.name")}
          message={notice}
          onClose={() => setNotice(undefined)}
        />
      )}
      <VisuallyHidden>
        <h1>{t("app.name")}</h1>
      </VisuallyHidden>
      {settings === null && loadingSlow && (
        <p role="status" className="app-notice">
          {t("app.loading")}
        </p>
      )}
      {engineFailed ? (
        <section role="alert" className="app-notice app-update-notice">
          <p>{t("graphics.status.engineFailed")}</p>
          <div className="app-update-actions">
            <Button onPress={reloadPage}>{t("graphics.status.reload")}</Button>
          </div>
        </section>
      ) : status?.reason === "device-loss" ? (
        <p role="status" className="app-notice">
          {t("graphics.status.deviceLossFallback")}
        </p>
      ) : (
        engineErrorShown &&
        !engineErrorDismissed && (
          <section role="status" className="app-notice app-update-notice">
            <p>{t("graphics.status.engineError")}</p>
            <div className="app-update-actions">
              <Button onPress={() => setEngineErrorDismissed(true)}>{t("dialog.close")}</Button>
            </div>
          </section>
        )
      )}
      <UpdateNotice updates={updates} onReload={applyUpdate} />
      <InstallNotice install={install} />
      <div
        className="app-canvas-frame"
        style={{ "--ruler-size": showRulers ? `${RULER_CSS_PIXELS}px` : "0px" } as CSSProperties}
      >
        {showRulers && activeDocument !== undefined && (
          <Rulers store={statusStore} doc={activeDocument} unit={units} />
        )}
        <div ref={viewport} className="app-viewport" data-backend={status?.backend}>
          <PixelGridOverlay
            store={statusStore}
            showGrid={showPixelGrid && activeDocument !== undefined}
          />
          <EffectProgress runtime={effectRuntime} store={statusStore} />
          <EffectAwareSelectionOutline
            runtime={effectRuntime}
            store={statusStore}
            document={activeDocument}
            animate={animations}
            antialiased={antialiasedOutline}
            layerPropertiesOpen={layerPropertiesOpen}
          />
          <BrushCursorOverlay store={statusStore} diameter={brushOutline} shape={brushTipShape} />
          <CloneSourceOverlay store={statusStore} />
          <WandHandlesOverlay store={statusStore} />
          <GradientHandlesOverlay store={statusStore} />
          <LineCurveHandlesOverlay store={statusStore} />
          <ShapeHandlesOverlay store={statusStore} />
          <TextFrameOverlay store={statusStore} />
          <TransformFrameOverlay store={statusStore} />
          <ZoomRectangleOverlay store={statusStore} />
        </div>
      </div>
    </AppShell>
  );
}
