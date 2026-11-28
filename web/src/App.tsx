import { useEffect, useLayoutEffect, useRef } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useNavigationType } from "react-router";
import { AutoplayPrompt, DevicesDialog } from "./components/Devices";
import { AddToPlaylistDialog, ForgetDialog, RadioReplaceDialog, ShareDialog, ShortcutsDialog } from "./components/Dialogs";
import { MiniPlayer, TabBar } from "./components/MobileChrome";
import { NowPlayingSheet, PanelDrawer, SidePanel } from "./components/NowPlaying";
import { LyricsPage } from "./components/Lyrics";
import { PlayerBar } from "./components/PlayerBar";
import { Rail } from "./components/Rail";
import { TitleBar } from "./components/TitleBar";
import { desktop } from "./lib/desktop";
import { SettingsDialog } from "./components/SettingsDialog";
import { Toasts } from "./components/Toasts";
import { TrackMenu } from "./components/TrackMenu";
import { FloatingVideo, Theater } from "./components/Video";
import { MD, useMediaQuery } from "./hooks/useMediaQuery";
import { useShortcuts } from "./hooks/useShortcuts";
import { getT } from "./i18n";
import { loadAccountSettings } from "./lib/accountSettings";
import { capabilities, link, openedLinks, startCar, syncAddress } from "./lib/api";
import { playLink } from "./lib/youtubeLink";
import { cn } from "./lib/format";
import { legacyRedirect, NOW_PLAYING_HASH, paths } from "./lib/routes";
import { selectHasShown, usePlayer } from "./player/player";
import { useAuth } from "./stores/auth";
import { useDevices } from "./stores/devices";
import { useLibrary } from "./stores/library";
import { useRecent } from "./stores/recent";
import { openSettings, useSystem } from "./stores/system";
import { toast, useUi } from "./stores/ui";
import Album from "./views/Album";
import YtPlaylist from "./views/YtPlaylist";
import Artist from "./views/Artist";
import BatchSearch from "./views/BatchSearch";
import Collection from "./views/Collection";
import Genre from "./views/Genre";
import SectionDetail from "./views/SectionDetail";
import Home from "./views/Home";
import Library from "./views/Library";
import Profile from "./views/Profile";
import Stats from "./views/Stats";
import Search from "./views/Search";

const SHEET_HASH = `#${NOW_PLAYING_HASH}`;

export default function App() {
  const location = useLocation();
  const legacy = legacyRedirect(location.pathname, location.search, location.hash);
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const isMd = useMediaQuery(MD);
  const panelOpen = useUi((s) => s.panelOpen);
  // A track here, or one playing on the device this one controls.
  const hasTrack = usePlayer(selectHasShown);
  const loadLibrary = useLibrary((s) => s.load);
  const loadSystem = useSystem((s) => s.load);
  const main = useRef<HTMLElement>(null);

  useShortcuts();

  useEffect(() => {
    void loadLibrary();
    void useRecent.getState().load();
  }, [loadLibrary]);

  // Without the devices' connection (a server on http), what other devices changed isn't heard: fetched again when
  // the window comes back after a while.
  useEffect(() => {
    if (syncAddress) return;
    let away = 0;
    let fetched = Date.now();
    const back = () => {
      if (document.visibilityState === "hidden") {
        away ||= Date.now();
        return;
      }
      const long = (away && Date.now() - away > 60_000) || Date.now() - fetched > 60_000;
      away = 0;
      if (!long) return;
      fetched = Date.now();
      void useLibrary.getState().refresh();
      void useRecent.getState().load();
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
    };
  }, []);

  // Android Auto's lists (the Android app only).
  useEffect(() => startCar?.(), []);

  // A YouTube link opened with the Android app, or shared to it, plays right away.
  useEffect(() => openedLinks?.((url) => void playLink(url, (path) => navigate(path))), [navigate]);

  // Settings that follow the account (the accent colour...): for whoever is signed in.
  const userId = useAuth((s) => s.user?.id);
  useEffect(() => {
    void loadAccountSettings();
  }, [userId]);

  // The server answers again (the Android app, connected to one): show what it has now.
  useEffect(() => {
    if (!link) return;
    let was = link.online;
    return link.subscribe(() => {
      if (link!.online && !was) {
        void loadLibrary();
        void useRecent.getState().load();
        void useAuth.getState().load();
        void loadAccountSettings();
      }
      was = link!.online;
    });
  }, [loadLibrary]);

  // Devices of this account in step (over https only; see stores/devices.ts).
  useEffect(() => {
    useDevices.getState().start();
    return () => useDevices.getState().stop();
  }, []);

  // Check yt-dlp shortly after start and say so once if something needs doing (not on Android: no yt-dlp there).
  useEffect(() => {
    if (!capabilities.engineSettings) return;
    const t = setTimeout(async () => {
      await loadSystem();
      const info = useSystem.getState().info;
      if (!info) return;
      const t = getT();
      if (!info.ytdlp.path) {
        toast(t.toasts.ytdlpMissing, "error", { label: t.common.install, run: openSettings });
        return;
      }
      const latest = info.ytdlp.latest[info.ytdlp.channel];
      const auth = useAuth.getState();
      // With accounts on, updating yt-dlp is the admin's job: don't nag the others.
      if (auth.enabled && auth.user?.role !== "admin") return;
      if (info.ytdlp.updateAvailable && latest) {
        try {
          if (sessionStorage.getItem("musike:update-notice") === latest) return;
          sessionStorage.setItem("musike:update-notice", latest);
        } catch {
          /* private mode */
        }
        toast(t.toasts.ytdlpUpdate(latest), "info", { label: t.common.update, run: openSettings });
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [loadSystem]);

  // Where each history entry was scrolled to, so Back returns to the same spot (say, deep in a genre's artists).
  const scrollMemo = useRef(new Map<string, number>());
  const entryKey = useRef(location.key);
  useEffect(() => {
    const el = main.current;
    if (!el) return;
    const onScroll = () => scrollMemo.current.set(entryKey.current, el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // New page, back to the top; Back and Forward return to where it was (the sheet hash is not a page change).
  // A layout effect, so the scroll the old page's removal causes is already filed under the new entry.
  useLayoutEffect(() => {
    entryKey.current = location.key;
    const saved = navigationType === "POP" ? scrollMemo.current.get(location.key) : undefined;
    main.current?.scrollTo({ top: 0 });
    // Pages that keep their data (genre, artist) render in full right away, so one frame is enough.
    if (saved) requestAnimationFrame(() => main.current?.scrollTo({ top: saved }));
  }, [location.pathname]);

  const sheetOpen = !isMd && location.hash === SHEET_HASH;
  const closeSheet = () => {
    // Pop the history entry the sheet pushed, so Back and the close button behave the same.
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate({ hash: "" }, { replace: true });
  };

  return (
    <div className={cn("grain flex h-dvh flex-col bg-bg md:gap-2 md:p-2", desktop && "md:pt-0")}>
      {desktop && <TitleBar />}
      <div className="flex min-h-0 flex-1 md:gap-2">
        <Rail />
        <main
          ref={main}
          className={cn(
            "scroll-area relative min-w-0 flex-1 overflow-y-auto md:rounded-[20px] md:bg-surface-1 md:ring-1 md:ring-line",
            hasTrack ? "pb-[calc(152px+env(safe-area-inset-bottom))]" : "pb-[calc(88px+env(safe-area-inset-bottom))]",
            "md:pb-0",
          )}
        >
          {legacy ? (
            <Navigate to={legacy} replace />
          ) : (
            <Routes>
              <Route path={paths.home} element={<Home />} />
              <Route path={paths.search} element={<Search />} />
              <Route path={paths.searchList} element={<BatchSearch />} />
              <Route path="/search/genre/:id" element={<Genre />} />
              <Route path="/search/artist/:id" element={<Artist />} />
              <Route path="/search/album/:id" element={<Album />} />
              <Route path="/search/playlist/:id" element={<YtPlaylist />} />
              <Route path="/discover/section" element={<SectionDetail />} />
              <Route path={paths.lyrics} element={<LyricsPage />} />
              <Route path={paths.library} element={<Library />} />
              <Route path={paths.profile} element={<Profile />} />
              <Route path={paths.stats} element={<Stats />} />
              <Route path={paths.favorites} element={<Collection kind="favorites" />} />
              <Route path={paths.history} element={<Collection kind="history" />} />
              <Route path="/playlist/:id" element={<Collection kind="playlist" />} />
              <Route path="*" element={<Home />} />
            </Routes>
          )}
        </main>
        {panelOpen && hasTrack && <SidePanel />}
      </div>

      {isMd ? (
        <PlayerBar />
      ) : (
        <>
          <MiniPlayer />
          <TabBar />
        </>
      )}

      <PanelDrawer />
      <NowPlayingSheet open={sheetOpen} onClose={closeSheet} />
      <FloatingVideo />
      <Theater />
      <TrackMenu />
      <AddToPlaylistDialog />
      <ShareDialog />
      <ForgetDialog />
      <RadioReplaceDialog />
      <AutoplayPrompt />
      <ShortcutsDialog />
      <DevicesDialog />
      <SettingsDialog />
      <Toasts />
    </div>
  );
}
