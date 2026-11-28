import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, session, shell } from "electron";
import type { RunningServer } from "../../server/src/app.js";
import { backupLibraryOnUpdate } from "./backup.js";

// No top-level await in this file: Electron only fires "ready" after the entry module finishes
// evaluating, so awaiting it at the top level would hang forever.

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4280; // fixed so the web origin (and its saved settings) stays the same between launches
const isMac = process.platform === "darwin";

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Everything the user owns lives in their profile, so updates and reinstalls keep it.
const userData = app.getPath("userData");
process.env.MUSIKE_DATA_DIR = path.join(userData, "data");
process.env.MUSIKE_CACHE_DIR = path.join(userData, "cache");
process.env.MUSIKE_BIN_DIR = path.join(userData, "bin");
// The desktop app keeps library.json (one user; the update backups below copy that file).
process.env.MUSIKE_LIBRARY = "json";
process.env.MUSIKE_WEB_DIST = app.isPackaged ? path.join(process.resourcesPath, "web") : path.resolve(here, "..", "..", "web", "dist");

// A copy of the library from before each update, in userData/backups (the installer makes one too).
backupLibraryOnUpdate(userData, app.getVersion());

// The server reads its config when first imported, so load it only after the env above is set.
const loadServer = async () => ({
  ...(await import("../../server/src/app.js")),
  ...(await import("../../server/src/bootstrap.js")),
  ...(await import("../../server/src/tools.js")),
  ...(await import("../../server/src/i18n.js")),
  HttpError: (await import("../../server/src/types.js")).HttpError,
});

const THEME = {
  dark: { color: "#0B0C0F", symbolColor: "#ECEEF2" },
  light: { color: "#E9EBEF", symbolColor: "#12141A" },
};
const TITLEBAR_HEIGHT = 40;

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

const stateFile = path.join(userData, "window.json");

// The language picked in the web app, kept here so the splash screen (shown before the web app loads) uses it too.
type Lang = "en" | "pt-BR" | "it" | "vi";
const settingsFile = path.join(userData, "settings.json");
const isLang = (v: unknown): v is Lang => v === "en" || v === "pt-BR" || v === "it" || v === "vi";

/**
 * `server`: the Musike server the app shows, instead of this computer's own library (Settings > Server);
 * `lastServer`: kept when switching back, to reconnect easily.
 */
interface Settings {
  lang?: Lang;
  server?: string | null;
  lastServer?: string;
}

function readSettings(): Settings {
  try {
    const s = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
    return {
      lang: isLang(s.lang) ? s.lang : undefined,
      server: typeof s.server === "string" ? serverAddress(s.server) : null,
      lastServer: typeof s.lastServer === "string" ? (serverAddress(s.lastServer) ?? undefined) : undefined,
    };
  } catch {
    return {}; // first launch
  }
}

function writeSettings(change: Settings) {
  try {
    writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), ...change }));
  } catch {
    /* not critical */
  }
}

/** "musike.home.arpa" or "http://192.168.1.10:4180/" → the origin (http(s) only), or null. */
function serverAddress(input: unknown): string | null {
  if (typeof input !== "string" || !input.trim()) return null;
  const raw = input.trim();
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password ? u.origin : null;
  } catch {
    return null;
  }
}

/** Does a Musike server answer there? */
async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(8000) });
    const body = res.ok ? ((await res.json()) as { ok?: unknown }) : null;
    return body?.ok === true;
  } catch {
    return false;
  }
}

let lang: Lang = readSettings().lang ?? "en";

const SERVER_DOWN: Record<Lang, (url: string) => string> = {
  en: (url) => `no Musike server answers at ${url}.`,
  "pt-BR": (url) => `nenhum servidor Musike responde em ${url}.`,
  it: (url) => `nessun server Musike risponde a ${url}.`,
  vi: (url) => `không có máy chủ Musike nào trả lời tại ${url}.`,
};

// Asked before a server's own page connects the app to a server.
const CONNECT: Record<Lang, { buttons: string[]; message: (url: string) => string }> = {
  en: { buttons: ["Connect", "Cancel"], message: (url) => `Connect Musike to ${url}?` },
  "pt-BR": { buttons: ["Conectar", "Cancelar"], message: (url) => `Conectar o Musike a ${url}?` },
  it: { buttons: ["Connetti", "Annulla"], message: (url) => `Connettere Musike a ${url}?` },
  vi: { buttons: ["Kết nối", "Hủy"], message: (url) => `Kết nối Musike với ${url}?` },
};

function readWindowState(): WindowState {
  try {
    const s = JSON.parse(readFileSync(stateFile, "utf8")) as WindowState;
    // Ignore a position that is no longer on any screen (monitor unplugged).
    const onScreen = screen
      .getAllDisplays()
      .some(({ workArea: a }) => s.x !== undefined && s.y !== undefined && s.x >= a.x - 50 && s.y >= a.y - 50 && s.x < a.x + a.width && s.y < a.y + a.height);
    return onScreen ? s : { width: s.width, height: s.height, maximized: s.maximized };
  } catch {
    return { width: 1280, height: 820 };
  }
}

function saveWindowState(win: BrowserWindow) {
  try {
    writeFileSync(stateFile, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
  } catch {
    /* not critical */
  }
}

// ── Windows taskbar thumbnail preview controls ──────────────────────────

interface MediaState {
  hasTrack: boolean;
  playing: boolean;
  favorite: boolean;
  labels: { favorite: string; previous: string; play: string; next: string };
}

let currentMedia: MediaState | null = null;
let thumbarReady = false;

function setThumbarButtons(win: BrowserWindow, state: MediaState) {
  const icon = (name: string) => nativeImage.createFromPath(path.join(here, `thumbar-${name}.png`));
  const flags: Electron.ThumbarButton["flags"] = state.hasTrack ? [] : ["disabled"];
  const buttons: Electron.ThumbarButton[] = [
    {
      icon: icon(state.favorite ? "favorite" : "add"),
      tooltip: state.labels.favorite,
      flags,
      click: () => win.webContents.send("musike:media-action", "favorite"),
    },
    {
      icon: icon("previous"),
      tooltip: state.labels.previous,
      flags,
      click: () => win.webContents.send("musike:media-action", "previous"),
    },
    {
      icon: icon(state.playing ? "pause" : "play"),
      tooltip: state.labels.play,
      flags,
      click: () => win.webContents.send("musike:media-action", "toggle"),
    },
    {
      icon: icon("next"),
      tooltip: state.labels.next,
      flags,
      click: () => win.webContents.send("musike:media-action", "next"),
    },
  ];
  win.setThumbarButtons(buttons);
}

function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 420,
    height: 300,
    frame: false,
    resizable: false,
    center: true,
    show: false,
    icon: path.join(here, "icon.png"),
    backgroundColor: THEME.dark.color,
    webPreferences: { preload: path.join(here, "preload.cjs"), sandbox: true, contextIsolation: true },
  });
  void splash.loadFile(path.join(here, "splash.html"), { query: { lang } });
  splash.once("ready-to-show", () => splash.show());
  return splash;
}

function createMainWindow(url: string): BrowserWindow {
  thumbarReady = false;
  currentMedia = null;
  const state = readWindowState();
  const win = new BrowserWindow({
    ...state,
    minWidth: 380,
    minHeight: 560,
    show: false,
    title: "Musike",
    icon: path.join(here, "icon.png"),
    backgroundColor: THEME.dark.color,
    // Our own title bar (drawn by the web app) with the native window buttons on top of it:
    // macOS traffic lights on the left, centred in the bar; Windows and Linux controls on the right.
    titleBarStyle: "hidden",
    ...(isMac
      ? { trafficLightPosition: { x: 14, y: (TITLEBAR_HEIGHT - 14) / 2 } }
      : { titleBarOverlay: { ...THEME.dark, height: TITLEBAR_HEIGHT } }),
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  win.once("ready-to-show", () => {
    if (state.maximized) win.maximize();
    win.show();
    // Windows needs time to create the taskbar button after the window is shown.
    // Registering the toolbar while the window is hidden can leave it invisible.
    if (process.platform === "win32") {
      setTimeout(() => {
        if (win.isDestroyed()) return;
        thumbarReady = true;
        if (currentMedia) setThumbarButtons(win, currentMedia);
      }, 500);
    }
  });
  win.on("close", () => saveWindowState(win));

  // Links to YouTube etc. open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (originOf(target) !== originOf(url)) {
      event.preventDefault();
      if (/^https?:\/\//.test(target)) void shell.openExternal(target);
    }
  });

  void win.loadURL(url);
  return win;
}

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

let mainWindow: BrowserWindow | null = null;
let server: RunningServer | null = null;

async function launch() {
  const splash = createSplash();
  const remote = readSettings().server;
  if (remote) {
    // A Musike server: its pages, its library and its music. Nothing to start here.
    if (server) {
      await server.close();
      server = null;
    }
    if (!(await reachable(remote))) {
      const message = JSON.stringify(SERVER_DOWN[lang](remote));
      await splash.webContents.executeJavaScript(`window.fail(${message}, true)`).catch(() => {});
      return;
    }
    mainWindow = createMainWindow(remote);
    mainWindow.once("ready-to-show", () => splash.destroy());
    return;
  }
  const s = await loadServer();
  // Show progress while yt-dlp and Deno download on the first launch.
  const report = setInterval(() => {
    splash.webContents.executeJavaScript(`window.update(${JSON.stringify(s.downloads(lang))})`).catch(() => {});
  }, 250);

  try {
    await s.refreshTools();
    await s.ensureEssentials();
    server ??= await s.startServer({ port: PORT, host: "127.0.0.1", portFallback: true });
    // FFmpeg is only needed for HD and some videos: fetch it in the background.
    s.ensureComponent("ffmpeg").catch(() => {});
  } catch (err) {
    clearInterval(report);
    const message = JSON.stringify(err instanceof s.HttpError ? s.tr(lang, err.text) : (err as Error).message);
    await splash.webContents.executeJavaScript(`window.fail(${message})`).catch(() => {});
    return;
  }

  clearInterval(report);
  mainWindow = createMainWindow(`http://127.0.0.1:${server.port}`);
  mainWindow.once("ready-to-show", () => splash.destroy());
}

ipcMain.on("musike:theme", (event, theme: "dark" | "light") => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const colors = THEME[theme] ?? THEME.dark;
  if (!isMac) win?.setTitleBarOverlay({ ...colors, height: TITLEBAR_HEIGHT });
  win?.setBackgroundColor(colors.color);
});

ipcMain.on("musike:lang", (_event, next: unknown) => {
  if (!isLang(next) || next === lang) return;
  lang = next;
  writeSettings({ lang });
});

/** Starts over with what settings.json says (this computer, or a server), in place of the window that asked. */
function relaunch(from: BrowserWindow | null) {
  // Open the new splash before closing the old one, or "window-all-closed" would quit the app.
  void launch();
  from?.destroy();
  if (from === mainWindow) mainWindow = null;
}

ipcMain.on("musike:retry", (event) => relaunch(BrowserWindow.fromWebContents(event.sender)));

/** Pages of this app itself (the local server, the splash), as opposed to a Musike server's. */
function fromThisApp(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? "";
  return url.startsWith("file://") || (!!server && originOf(url) === `http://127.0.0.1:${server.port}`);
}

/** For Settings > Server: where the app is now, and the server it knew last. */
ipcMain.on("musike:server", (event) => {
  const s = readSettings();
  event.returnValue = { server: s.server ?? null, last: s.lastServer ?? s.server ?? "" };
});

type ConnectResult = { ok: true } | { error: "invalid" | "unreachable" | "cancelled" };

/** Settings > Server: a Musike server's address, or null for this computer. The app starts over there. */
ipcMain.handle("musike:connect", async (event, input: unknown): Promise<ConnectResult> => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (input === null) {
    writeSettings({ server: null });
    relaunch(win);
    return { ok: true };
  }
  const url = serverAddress(input);
  if (!url) return { error: "invalid" };
  // Asked by a server's page rather than this app's own: the person says yes first.
  if (!fromThisApp(event) && win) {
    const { response } = await dialog.showMessageBox(win, {
      type: "question",
      buttons: CONNECT[lang].buttons,
      defaultId: 1,
      cancelId: 1,
      message: CONNECT[lang].message(url),
    });
    if (response !== 0) return { error: "cancelled" };
  }
  if (!(await reachable(url))) return { error: "unreachable" };
  writeSettings({ server: url, lastServer: url });
  relaunch(win);
  return { ok: true };
});

/** This computer's own library (library.json), to copy into an account on the server. */
ipcMain.handle("musike:local-library", (event) => {
  const remote = readSettings().server;
  if (!fromThisApp(event) && originOf(event.senderFrame?.url ?? "") !== remote) return null;
  try {
    return JSON.parse(readFileSync(path.join(userData, "data", "library.json"), "utf8")) as unknown;
  } catch {
    return null;
  }
});

// ── Windows taskbar thumbnail preview controls ──────────────────────────

ipcMain.on("musike:media", (event, media: MediaState) => {
  if (event.sender !== mainWindow?.webContents) return;
  currentMedia = media;
  if (mainWindow && process.platform === "win32" && thumbarReady) {
    setThumbarButtons(mainWindow, media);
  }
});

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => void server?.close());

void app.whenReady().then(() => {
  // A server's pages get no more than the app's own: full screen for videos, copying links. Nothing else.
  const allowed = new Set(["fullscreen", "clipboard-sanitized-write"]);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => done(allowed.has(permission)));
  // macOS needs an app menu: without the Edit menu, Cmd+C/V/A don't reach text fields, and Cmd+Q has no home.
  Menu.setApplicationMenu(
    isMac ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]) : null,
  );
  return launch();
});
