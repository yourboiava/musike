import { contextBridge, ipcRenderer } from "electron";

// Where the app is (this computer, or a Musike server), asked once as the page starts.
const place = ipcRenderer.sendSync("musike:server") as { server: string | null; last: string };

// The only bridge between the web app and the desktop shell.
contextBridge.exposeInMainWorld("musikeDesktop", {
  platform: process.platform,
  setTheme: (theme: "dark" | "light") => ipcRenderer.send("musike:theme", theme),
  setLanguage: (lang: string) => ipcRenderer.send("musike:lang", lang),
  retry: () => ipcRenderer.send("musike:retry"),
  /** The Musike server the app shows, or null for this computer's own library; and the last server used. */
  server: place.server,
  lastServer: place.last,
  /** Switches to a Musike server (or back to this computer with null): the app starts over there. */
  connect: (url: string | null) => ipcRenderer.invoke("musike:connect", url),
  /** This computer's own library, to copy into an account on the server. */
  localLibrary: () => ipcRenderer.invoke("musike:local-library"),
  // Windows taskbar thumbnail controls
  updateMediaControls: (state: { hasTrack: boolean; playing: boolean; favorite: boolean; labels: { favorite: string; previous: string; play: string; next: string } }) =>
    ipcRenderer.send("musike:media", state),
  onMediaAction: (fn: (action: "toggle" | "next" | "previous" | "favorite") => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: "toggle" | "next" | "previous" | "favorite") => fn(action);
    ipcRenderer.on("musike:media-action", handler);
    return () => ipcRenderer.removeListener("musike:media-action", handler);
  },
});
