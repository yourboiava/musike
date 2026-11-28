/** Bridge exposed by the Electron preload script when Musike runs as the desktop app. */
type MediaAction = "toggle" | "next" | "previous" | "favorite";

interface DesktopBridge {
  platform: string;
  setTheme: (theme: "dark" | "light") => void;
  /** Missing in desktop builds older than 1.2. */
  setLanguage?: (lang: string) => void;
  /** Settings > Server (missing in builds that only have this computer's library): the server shown, or null. */
  server?: string | null;
  lastServer?: string;
  /** Switches to a Musike server, or back to this computer with null: the app starts over there. */
  connect?: (url: string | null) => Promise<{ ok: true } | { error: "invalid" | "unreachable" | "cancelled" }>;
  /** This computer's own library (null when there is none). */
  localLibrary?: () => Promise<unknown>;
  updateMediaControls?: (state: { hasTrack: boolean; playing: boolean; favorite: boolean; labels: { favorite: string; previous: string; play: string; next: string } }) => void;
  onMediaAction?: (fn: (action: MediaAction) => void) => () => void;
}

export const desktop = (window as Window & { musikeDesktop?: DesktopBridge }).musikeDesktop;

if (desktop) {
  document.documentElement.dataset.desktop = "true";
  // Match the native window buttons to the theme picked before this script ran.
  desktop.setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
}
