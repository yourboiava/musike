import {
  CaretDownIcon,
  MicrophoneStageIcon,
  MagnifyingGlassIcon,
  QueueIcon,
  DotsThreeVerticalIcon,
  RadioIcon,
  ShareNetworkIcon,
  VideoCameraSlashIcon,
  XIcon,
} from "@phosphor-icons/react";
import { startRadio } from "../lib/radio";
import { share } from "../lib/share";
import { AnimatePresence, motion, useDragControls, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { cn } from "../lib/format";
import type { Track } from "../lib/types";
import { selectShown, selectShownIndex, selectShownQueue, selectShownStatus, usePlayer, useStatusText } from "../player/player";
import { useDevices } from "../stores/devices";
import { useUi, type PanelTab } from "../stores/ui";
import { AlbumLink, ArtistLink } from "./ArtistLink";
import { DevicesButton, ElsewhereNote } from "./Devices";
import { Marquee } from "./Marquee";
import { Artwork } from "./Artwork";
import { FavoriteButton, ModeSwitch, Scrubber, SleepButton, Transport, useVideoAvailable, Volume } from "./Controls";
import { IconButton } from "./IconButton";
import { LyricsView, useLyricsNavigation } from "./Lyrics";
import { QueueList } from "./Queue";
import { SLOT, VideoSlot } from "./Video";
import { isTvMode } from "../tv/tvMode";

/** Artwork or the live video, with a soft ambient glow from the cover behind it. */
function Stage({ track, slot, className }: { track: Track; slot: number; className?: string }) {
  const t = useT();
  // While controlling another device, this one's video isn't what plays: the picture is.
  const showsVideo = usePlayer((s) => s.mediaKind === "video" && !s.remote);
  const aspect = usePlayer((s) => s.videoAspect);
  // In Video mode on a song: say we're looking for its clip, or that it has none.
  const note = usePlayer((s) =>
    s.preferVideo && !s.remote ? (s.videoNote ?? (s.statusText === "findingClip" ? s.statusText : null)) : null,
  );
  if (showsVideo) {
    const portrait = aspect < 1;
    return (
      <div className="flex justify-center">
        <VideoSlot
          priority={slot}
          expandable
          className={cn("rounded-[16px]", portrait ? "h-[min(52dvh,560px)]" : "w-full")}
          style={{ aspectRatio: Math.min(16 / 9, Math.max(9 / 16, aspect)) }}
        />
      </div>
    );
  }
  // A video's picture is a 16:9 frame: shown whole, not cropped to a square (on Android without a server, videos
  // play as audio, so this is what shows).
  return (
    <div className={cn("relative mx-auto w-full", track.kind === "video" ? "aspect-video" : "aspect-square", className)}>
      <img
        src={track.thumb}
        alt=""
        aria-hidden="true"
        className="absolute inset-[8%] h-[84%] w-[84%] scale-110 rounded-full object-cover opacity-50 blur-3xl"
      />
      <Artwork
        src={track.art}
        fallback={track.thumb}
        alt={t.nowPlaying.coverOf(track.title)}
        iconSize={48}
        className="relative size-full rounded-[18px] shadow-[0_24px_60px_rgb(0_0_0/0.45)]"
      />
      {note && (
        <span className="absolute inset-x-3 bottom-3 flex items-center justify-center gap-2 rounded-full bg-black/65 px-3 py-2 text-center text-[13px] font-medium text-white backdrop-blur-md">
          {note === "findingClip" ? (
            <MagnifyingGlassIcon size={16} className="shrink-0" />
          ) : (
            <VideoCameraSlashIcon size={16} className="shrink-0" />
          )}{" "}
          {note === "findingClip" ? t.player.status.findingClip : t.player.noClip}
        </span>
      )}
    </div>
  );
}

function TrackHeading({ track, large = false }: { track: Track; large?: boolean }) {
  const statusText = useStatusText();
  const status = usePlayer(selectShownStatus);
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        {/* A title that doesn't fit slides along too, like the artist and album under it. */}
        <h2 className={cn("font-semibold tracking-tight", large ? "text-[22px] leading-tight" : "text-lg")}>
          <Marquee key={track.id}>{track.title}</Marquee>
        </h2>
        <div className={cn(large ? "text-base" : "text-sm", status === "error" ? "text-danger" : "text-fg-2")}>
          {statusText ? (
            <p className="truncate">{statusText}</p>
          ) : (
            // Long credits slide along, and can be dragged, so every name stays readable and clickable.
            <Marquee key={track.id}>
              {/* `large` is the phone sheet: the artist page replaces it in history, so Back doesn't reopen it. */}
              <ArtistLink track={track} replace={large} />
              {track.album && (
                <>
                  {" · "}
                  <AlbumLink track={track} replace={large} />
                </>
              )}
            </Marquee>
          )}
        </div>
      </div>
      {/* The phone keeps only the heart here (the title needs the room): Share and the track's menu are in the row
          at the bottom of the sheet. */}
      {!large && <ShareButton track={track} />}
      <FavoriteButton track={track} size={large ? "lg" : "md"} />
    </div>
  );
}

function ShareButton({ track }: { track: Track }) {
  const t = useT();
  return (
    <IconButton
      label={t.share.shareX(track.title)}
      size="md"
      onClick={() => share({ kind: "track", id: track.id, title: track.title, artist: track.artist })}
    >
      <ShareNetworkIcon size={22} />
    </IconButton>
  );
}

/** The phone sheet's "More": the track's menu (Share, Start radio, Add to playlist, Go to artist...). */
function MoreButton({ track, slim = false, className }: { track: Track; slim?: boolean; className?: string }) {
  const openMenu = useUi((s) => s.openMenu);
  const t = useT();
  return (
    <IconButton
      label={t.trackMenu.actionsFor(track.title)}
      size={slim ? "slim" : "md"}
      className={className}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        // The sheet has its own Start radio button.
        openMenu({ track, x: r.right, y: r.bottom, noRadio: slim });
      }}
    >
      <DotsThreeVerticalIcon size={slim ? 20 : 22} weight="bold" />
    </IconButton>
  );
}

function usePanelTab(): { tab: PanelTab; showLyrics: boolean } {
  const tab = useUi((s) => s.panelTab);
  const { atLyrics } = useLyricsNavigation();
  if (!atLyrics) return { tab, showLyrics: true };
  // The lyrics already fill the middle column: repeating them here would just be a smaller copy.
  return { tab: tab === "lyrics" ? "playing" : tab, showLyrics: false };
}

function PanelBody({ tab, slot }: { tab: PanelTab; slot: number }) {
  const track = usePlayer(selectShown);
  const queue = usePlayer(selectShownQueue);
  const index = usePlayer(selectShownIndex);
  const t = useT();

  if (tab === "queue") return <QueueList />;
  if (tab === "lyrics") return <LyricsView className="h-full" />;
  if (!track) {
    return <p className="px-2 py-16 text-center text-sm text-fg-2">{t.nowPlaying.playSomething}</p>;
  }
  const nextUp = queue[index + 1];
  return (
    <div className="flex flex-col gap-5 px-1 pb-4">
      <Stage track={track} slot={slot} />
      <TrackHeading track={track} />
      <ModeSwitch />
      <button
        type="button"
        onClick={() => startRadio(track)}
        className="flex h-11 items-center justify-center gap-2 rounded-full bg-surface-1 text-sm font-medium ring-1 ring-line transition-colors hover:bg-surface-3 active:scale-[0.98]"
      >
        <RadioIcon size={18} /> {t.nowPlaying.startRadio}
      </button>
      {nextUp && (
        <div className="rounded-[14px] bg-surface-1 p-3 ring-1 ring-line">
          <p className="pb-2 text-xs font-medium text-fg-3">{t.nowPlaying.upNext}</p>
          <div className="flex items-center gap-3">
            <Artwork src={nextUp.thumb} className="size-10 rounded-[8px]" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{nextUp.title}</p>
              <p className="truncate text-xs text-fg-2">{nextUp.artist}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PanelTabs({ tab, showLyrics, onTab }: { tab: PanelTab; showLyrics: boolean; onTab: (t: PanelTab) => void }) {
  const t = useT();
  const tabs = [
    ["playing", t.nowPlaying.tabPlaying],
    ["lyrics", t.nowPlaying.tabLyrics],
    ["queue", t.nowPlaying.tabQueue],
  ] as const;
  return (
    <div role="tablist" className="flex gap-1">
      {tabs
        .filter(([id]) => showLyrics || id !== "lyrics")
        .map(([id, label]) => (
        <button
          key={id}
          role="tab"
          type="button"
          aria-selected={tab === id}
          onClick={() => onTab(id)}
          className={cn(
            "h-9 rounded-full px-4 text-sm font-medium transition-colors",
            tab === id ? "bg-surface-4 text-fg" : "text-fg-2 hover:text-fg",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Docked right column (≥1280px). On a TV Now Playing is a full screen of its own instead (TvNowPlaying). */
export function SidePanel() {
  const { tab, showLyrics } = usePanelTab();
  const openPanel = useUi((s) => s.openPanel);
  const togglePanel = useUi((s) => s.togglePanel);
  const t = useT();
  if (isTvMode()) return null;
  return (
    <aside className="island hidden w-[360px] shrink-0 xl:flex" aria-label={t.nowPlaying.panel}>
      <div className="island-core flex w-full flex-col overflow-hidden">
        <div className="flex h-16 items-center justify-between px-3">
          <PanelTabs tab={tab} showLyrics={showLyrics} onTab={openPanel} />
          <IconButton label={t.nowPlaying.closePanel} size="sm" onClick={() => togglePanel(tab)}>
            <XIcon size={18} />
          </IconButton>
        </div>
        <div className="scroll-area flex-1 overflow-y-auto px-2">
          <PanelBody tab={tab} slot={SLOT.panel} />
        </div>
      </div>
    </aside>
  );
}

/**
 * Android TV: Now Playing fills the screen, read from the sofa. On the left the cover (or the video), the title and
 * the controls; on the right the queue or the lyrics, large. Opened by everything that opens the panel elsewhere
 * (the cover in the player bar, Queue, Lyrics); Back closes it. The D-pad stays inside (it's a dialog).
 */
function TvNowPlaying({ tab, onTab, onClose }: { tab: PanelTab; onTab: (t: PanelTab) => void; onClose: () => void }) {
  const track = usePlayer(selectShown);
  const queue = usePlayer(selectShownQueue);
  const t = useT();
  const side: PanelTab = tab === "lyrics" ? "lyrics" : "queue";
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t.nowPlaying.panel}
      data-escape-closes
      data-tv-now-playing
      className="fixed inset-0 z-40 overflow-hidden bg-bg"
    >
      {track && (
        <img src={track.thumb} alt="" aria-hidden="true" className="absolute inset-0 size-full scale-125 object-cover opacity-25 blur-[80px]" />
      )}
      <div className="relative grid h-full grid-cols-[minmax(0,5fr)_minmax(0,6fr)] gap-8 px-10 py-6">
        <div className="flex min-h-0 flex-col justify-center gap-3">
          {track ? (
            <>
              {/* Sized to the screen's height: cover, title, bar, controls and the last row fit in 540 px. */}
              <Stage track={track} slot={SLOT.panel} className={track.kind === "video" ? "w-full" : "!w-[36vh]"} />
              <TrackHeading track={track} large />
              <Scrubber />
              {/* The D-pad starts on Play/Pause (tvMode.ts focuses [data-tv-autofocus]): OK pauses, Left/Right reach the rest. */}
              <Transport big tvAutofocus />
              <div className="flex items-center justify-center gap-3">
                <ModeSwitch compact />
                <button
                  type="button"
                  onClick={() => startRadio(track)}
                  className="flex h-10 items-center gap-2 rounded-full bg-surface-1 px-4 text-sm font-medium whitespace-nowrap ring-1 ring-line"
                >
                  <RadioIcon size={18} /> {t.trackMenu.startRadio}
                </button>
              </div>
            </>
          ) : (
            <p className="text-center text-lg text-fg-2">{t.nowPlaying.playSomething}</p>
          )}
        </div>
        <div className="flex min-h-0 flex-col rounded-[24px] bg-surface-1/70 ring-1 ring-line backdrop-blur-md">
          <div className="flex h-16 shrink-0 items-center justify-between px-4">
            <div role="tablist" className="flex gap-1">
              {(
                [
                  ["queue", `${t.nowPlaying.tabQueue}${queue.length ? ` · ${queue.length}` : ""}`],
                  ["lyrics", t.nowPlaying.tabLyrics],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  role="tab"
                  type="button"
                  aria-selected={side === id}
                  onClick={() => onTab(id)}
                  className={cn("h-10 rounded-full px-5 text-base font-medium whitespace-nowrap", side === id ? "bg-surface-4 text-fg" : "text-fg-2")}
                >
                  {label}
                </button>
              ))}
            </div>
            <IconButton label={t.common.close} size="md" onClick={onClose}>
              <XIcon size={22} />
            </IconButton>
          </div>
          <div className="scroll-area min-h-0 flex-1 overflow-y-auto px-3 pb-3 text-base">
            <PanelBody tab={side} slot={SLOT.panel} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Same content as an overlay drawer for tablets and small laptops (768-1279px); on a TV, a full screen. */
export function PanelDrawer() {
  const open = useUi((s) => s.drawerOpen);
  const { tab, showLyrics } = usePanelTab();
  const openPanel = useUi((s) => s.openPanel);
  const close = useUi((s) => s.closePanel);
  const reduce = useReducedMotion();
  const t = useT();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (isTvMode()) return createPortal(open ? <TvNowPlaying tab={tab} onTab={openPanel} onClose={close} /> : null, document.body);

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-40 hidden md:block xl:hidden">
          <motion.div className="absolute inset-0 bg-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={close} />
          <motion.aside
            aria-label={t.nowPlaying.panel}
            data-escape-closes
            initial={reduce ? { opacity: 0 } : { x: "105%" }}
            animate={{ x: 0, opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { x: "105%" }}
            transition={{ type: "spring", stiffness: 380, damping: 38 }}
            className="island drawer-top absolute right-2 bottom-2 flex w-[380px] max-w-[calc(100vw-16px)]"
          >
            <div className="island-core flex w-full flex-col overflow-hidden">
              <div className="flex h-16 items-center justify-between px-3">
                <PanelTabs tab={tab} showLyrics={showLyrics} onTab={openPanel} />
                <IconButton label={t.common.close} size="sm" onClick={close}>
                  <XIcon size={18} />
                </IconButton>
              </div>
              <div className="scroll-area flex-1 overflow-y-auto px-2">
                <PanelBody tab={tab} slot={SLOT.panel} />
              </div>
            </div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

type SheetView = "player" | "queue" | "lyrics";

/** Lyrics and queue on the phone: the two ends of the row at the bottom of the sheet, within reach of the thumb. */
function SheetViewButton({ target, view, setView }: { target: "queue" | "lyrics"; view: SheetView; setView: (v: SheetView) => void }) {
  const t = useT();
  const on = view === target;
  const label = on ? t.nowPlaying.backToPlayer : target === "queue" ? t.nowPlaying.showQueue : t.lyrics.show;
  return (
    <IconButton label={label} active={on} onClick={() => setView(on ? "player" : target)} className="shrink-0">
      {target === "queue" ? <QueueIcon size={22} /> : <MicrophoneStageIcon size={22} />}
    </IconButton>
  );
}

/**
 * Everything for the track within reach of the thumb, under the controls: the sheet's header keeps only Close.
 * Symmetric with whatever buttons there are: around Audio/Video, under Play, its two sides take the same width
 * (three and three, or two wider ones without devices); without video, the buttons share the row evenly.
 */
function SheetRow({ track, view, setView }: { track: Track; view: SheetView; setView: (v: SheetView) => void }) {
  const t = useT();
  const hasDevices = useDevices((s) => s.status !== "off");
  const hasVideo = useVideoAvailable();
  const left = [
    <IconButton key="radio" label={t.trackMenu.startRadio} onClick={() => startRadio(track)}>
      <RadioIcon size={22} />
    </IconButton>,
    <SheetViewButton key="lyrics" target="lyrics" view={view} setView={setView} />,
    ...(hasDevices ? [<DevicesButton key="devices" size="md" />] : []),
  ];
  const right = [
    <ShareButton key="share" track={track} />,
    <SheetViewButton key="queue" target="queue" view={view} setView={setView} />,
    <MoreButton key="more" track={track} slim />,
  ];
  const columns = hasVideo
    ? `repeat(${left.length}, ${right.length / left.length}fr) auto repeat(${right.length}, 1fr)`
    : `repeat(${left.length + right.length}, 1fr)`;
  // A little apart from Play, and as wide as the sheet allows (into its side margins), with room around Audio/Video:
  // seven things in a phone's width.
  return (
    <div className="-mx-3 mt-3 grid items-center justify-items-center" style={{ gridTemplateColumns: columns }}>
      {left}
      {hasVideo && <ModeSwitch key="mode" compact className="mx-1" />}
      {right}
    </div>
  );
}

/** Full-screen Now Playing for phones. Drag down (or Back) to close. */
export function NowPlayingSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const track = usePlayer(selectShown);
  // On a phone the buttons on its side set its own volume; the other device's needs a slider.
  const elsewhere = usePlayer((s) => !!s.remote);
  const reduce = useReducedMotion();
  const drag = useDragControls();
  const [view, setView] = useState<SheetView>("player");
  const t = useT();

  return createPortal(
    <AnimatePresence onExitComplete={() => setView("player")}>
      {open && track && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={t.nowPlaying.title}
          initial={reduce ? { opacity: 0 } : { y: "100%" }}
          animate={{ y: 0, opacity: 1 }}
          exit={reduce ? { opacity: 0 } : { y: "100%" }}
          transition={{ type: "spring", stiffness: 380, damping: 36 }}
          drag="y"
          dragListener={false}
          dragControls={drag}
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={{ top: 0, bottom: 0.9 }}
          onDragEnd={(_, info) => {
            if (info.offset.y > 120 || info.velocity.y > 700) onClose();
          }}
          className="fixed inset-0 z-40 flex flex-col overflow-hidden bg-bg md:hidden"
        >
          <img
            src={track.thumb}
            alt=""
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 h-1/2 w-full scale-125 object-cover opacity-25 blur-3xl"
          />
          <div className="pointer-events-none absolute inset-0 bg-linear-to-b from-transparent via-bg/70 to-bg" />

          <div className="overlay-top relative flex min-h-0 flex-1 flex-col px-5">
            <div className="relative flex h-14 touch-none items-center justify-between" onPointerDown={(e) => drag.start(e)}>
              <IconButton label={t.common.close} onClick={onClose} className="-ml-2 text-fg">
                <CaretDownIcon size={24} />
              </IconButton>
              <SleepButton size="md" className="-mr-2" />
              {/* In the middle of the sheet, whatever the buttons on either side. */}
              <div className="pointer-events-none absolute top-1/2 left-1/2 h-1 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg-3/50" />
            </div>

            {view !== "player" ? (
              <>
                {view === "queue" ? (
                  <div className="scroll-area -mx-3 min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6">
                    <QueueList />
                  </div>
                ) : (
                  <LyricsView mode="sheet" className="-mx-3 flex-1" />
                )}
                {/* The same two buttons as under the player, with the controls between them. */}
                <div className="flex items-center justify-between gap-2 pt-2 pb-[calc(12px+env(safe-area-inset-bottom))]">
                  <SheetViewButton target="lyrics" view={view} setView={setView} />
                  <Transport />
                  <SheetViewButton target="queue" view={view} setView={setView} />
                </div>
              </>
            ) : (
              <div className="flex flex-1 flex-col justify-evenly gap-4 pb-[calc(16px+env(safe-area-inset-bottom))]">
                <div className="touch-none" onPointerDown={(e) => drag.start(e)}>
                  <Stage track={track} slot={SLOT.sheet} className="max-w-[min(100%,46dvh)]" />
                </div>
                <div className="flex flex-col gap-4">
                  <TrackHeading track={track} large />
                  <Scrubber touch />
                  <Transport big />
                  {elsewhere && <Volume wide className="w-full" />}
                  <SheetRow track={track} view={view} setView={setView} />
                  <ElsewhereNote className="justify-center" />
                </div>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
