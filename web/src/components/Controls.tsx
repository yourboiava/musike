import {
  MoonStarsIcon,
  HeartIcon,
  MusicNotesIcon,
  PauseIcon,
  PlayIcon,
  RepeatIcon,
  RepeatOnceIcon,
  ShuffleIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SpeakerHighIcon,
  SpeakerLowIcon,
  SpeakerXIcon,
  VideoCameraIcon,
} from "@phosphor-icons/react";
import { type CSSProperties, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { useT } from "../i18n";
import { api, capabilities, link } from "../lib/api";
import { cn, formatTime } from "../lib/format";
import type { Track } from "../lib/types";
import {
  playingVideoId,
  type Quality,
  selectCurrent,
  selectHasShown,
  selectShownDuration,
  selectShownPosition,
  selectShownStatus,
  usePlayer,
} from "../player/player";
import { useLibrary } from "../stores/library";
import { IconButton, PlayDisc } from "./IconButton";
import { Slider } from "./Slider";

export function PlayPauseIcon({ size = 22 }: { size?: number }) {
  const status = usePlayer(selectShownStatus);
  if (status === "loading") {
    return (
      <span className="relative block size-[18px]" aria-hidden="true">
        <span className="absolute inset-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
        <span className="absolute inset-0 m-auto size-1.5 rounded-[1px] bg-current opacity-0 transition-opacity group-hover/play:opacity-100 group-focus-visible/play:opacity-100 [@media(hover:none)]:opacity-100" />
      </span>
    );
  }
  return status === "playing" ? <PauseIcon size={size} weight="fill" /> : <PlayIcon size={size} weight="fill" />;
}

export function Transport({ big = false, tvAutofocus = false }: { big?: boolean; tvAutofocus?: boolean }) {
  const t = useT();
  const p = usePlayer(
    useShallow((s) => ({
      // This device's player, or the device it controls.
      hasQueue: selectHasShown(s),
      status: selectShownStatus(s),
      shuffle: s.remote ? s.remote.shuffle : s.shuffle,
      repeat: s.remote ? s.remote.repeat : s.repeat,
      toggle: s.toggle,
      prev: s.prev,
      next: s.next,
      toggleShuffle: s.toggleShuffle,
      cycleRepeat: s.cycleRepeat,
    })),
  );
  const hasTrack = p.hasQueue;
  const RepeatGlyph = p.repeat === "one" ? RepeatOnceIcon : RepeatIcon;
  const repeatLabel = { off: t.player.repeatOff, all: t.player.repeatAll, one: t.player.repeatOne }[p.repeat];
  const iconSize = big ? 26 : 19;

  return (
    <div className={cn("flex items-center", big ? "justify-between" : "gap-2")}>
      <IconButton
        label={p.shuffle ? t.player.shuffleOn : t.player.shuffleOff}
        active={p.shuffle}
        size={big ? "lg" : "sm"}
        onClick={p.toggleShuffle}
        disabled={!hasTrack}
      >
        <ShuffleIcon size={big ? 22 : 17} />
        {p.shuffle && <span className="absolute bottom-0.5 size-1 rounded-full bg-accent-text" />}
      </IconButton>
      <IconButton label={t.player.previous} size={big ? "lg" : "md"} onClick={p.prev} disabled={!hasTrack} className="text-fg">
        <SkipBackIcon size={iconSize} weight="fill" />
      </IconButton>
      <PlayDisc
        label={p.status === "loading" ? t.common.stopLoading : p.status === "playing" ? t.common.pause : t.common.play}
        className="group/play"
        data-tv-autofocus={tvAutofocus || undefined}
        px={big ? 72 : 40}
        onClick={p.toggle}
        disabled={!hasTrack}
      >
        <PlayPauseIcon size={big ? 30 : 20} />
      </PlayDisc>
      <IconButton label={t.player.next} size={big ? "lg" : "md"} onClick={p.next} disabled={!hasTrack} className="text-fg">
        <SkipForwardIcon size={iconSize} weight="fill" />
      </IconButton>
      <IconButton
        label={repeatLabel}
        active={p.repeat !== "off"}
        size={big ? "lg" : "sm"}
        onClick={p.cycleRepeat}
        disabled={!hasTrack}
      >
        <RepeatGlyph size={big ? 22 : 17} />
        {p.repeat !== "off" && <span className="absolute bottom-0.5 size-1 rounded-full bg-accent-text" />}
      </IconButton>
    </div>
  );
}

export function Scrubber({ touch = false, className }: { touch?: boolean; className?: string }) {
  const t = useT();
  const position = usePlayer(selectShownPosition);
  const duration = usePlayer(selectShownDuration);
  const buffered = usePlayer((s) => (s.remote ? 0 : s.buffered));
  const seek = usePlayer((s) => s.seek);
  const [scrub, setScrub] = useState<number | null>(null);
  const shown = scrub ?? position;

  const time = <span className="w-10 shrink-0 font-mono text-[11px] text-fg-3 tabular-nums">{formatTime(shown)}</span>;
  const total = <span className="w-10 shrink-0 text-right font-mono text-[11px] text-fg-3 tabular-nums">{formatTime(duration)}</span>;

  if (touch) {
    return (
      <div className={className}>
        <Slider label={t.player.progress} value={position} max={duration} buffered={buffered} onChange={seek} onScrub={setScrub} showThumb step={5} valueText={formatTime} />
        <div className="mt-0.5 flex justify-between">
          {time}
          {total}
        </div>
      </div>
    );
  }
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span className="text-right">{time}</span>
      <Slider label={t.player.progress} value={position} max={duration} buffered={buffered} onChange={seek} onScrub={setScrub} step={5} valueText={formatTime} className="flex-1" />
      {total}
    </div>
  );
}

/** `wide`: the slider takes the room there is (the phone's Now Playing, controlling another device). */
export function Volume({ className, wide = false }: { className?: string; wide?: boolean }) {
  const t = useT();
  // This device's volume, or the one of the device it controls.
  const volume = usePlayer((s) => s.remote?.volume ?? s.volume);
  const muted = usePlayer((s) => s.remote?.muted ?? s.muted);
  const setVolume = usePlayer((s) => s.setVolume);
  const toggleMute = usePlayer((s) => s.toggleMute);
  const level = muted ? 0 : volume;
  const Glyph = level === 0 ? SpeakerXIcon : level < 0.5 ? SpeakerLowIcon : SpeakerHighIcon;
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <IconButton label={muted ? t.player.unmute : t.player.mute} size="sm" onClick={toggleMute}>
        <Glyph size={18} />
      </IconButton>
      <Slider
        label={t.player.volume}
        value={level}
        max={1}
        step={0.05}
        live
        onChange={setVolume}
        valueText={(v) => `${Math.round(v * 100)}%`}
        className={wide ? "flex-1" : "w-24"}
      />
    </div>
  );
}

/**
 * The volume where the bar has no room for the slider (a window snapped to half a screen): the speaker opens it
 * above, with the mute button. The wheel on the speaker changes the volume too.
 */
export function VolumePopover({ className }: { className?: string }) {
  const t = useT();
  const volume = usePlayer((s) => s.remote?.volume ?? s.volume);
  const muted = usePlayer((s) => s.remote?.muted ?? s.muted);
  const setVolume = usePlayer((s) => s.setVolume);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const level = muted ? 0 : volume;
  const Glyph = level === 0 ? SpeakerXIcon : level < 0.5 ? SpeakerLowIcon : SpeakerHighIcon;

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div
      ref={box}
      className={cn("relative", className)}
      onWheel={(e) => setVolume(Math.min(1, Math.max(0, level + (e.deltaY < 0 ? 0.05 : -0.05))))}
    >
      <IconButton label={t.player.volume} size="sm" active={open} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Glyph size={18} />
      </IconButton>
      {open && (
        <div className="absolute right-0 bottom-full z-30 mb-3 rounded-full bg-surface-3 px-2 py-1.5 shadow-lg ring-1 ring-line">
          <Volume />
        </div>
      )}
    </div>
  );
}

export function FavoriteButton({ track, size = "md" }: { track: Track | null; size?: "sm" | "md" | "lg" }) {
  const isFavorite = useLibrary((s) => !!track && s.favorites.some((t) => t.id === track.id));
  const toggle = useLibrary((s) => s.toggleFavorite);
  const t = useT();
  return (
    <IconButton
      label={isFavorite ? t.common.removeFromFavorites : t.common.addToFavorites}
      active={isFavorite}
      size={size}
      disabled={!track}
      onClick={() => track && void toggle(track)}
    >
      <HeartIcon size={size === "lg" ? 24 : 19} weight={isFavorite ? "fill" : "regular"} />
    </IconButton>
  );
}

/**
 * Where a small menu opens, fixed to the window so no panel's edge cuts it: above or under its button, on the side
 * with more room (a phone held sideways is short: a fixed threshold sent the cinema view's menu under the screen); lined up with the button's right edge (or in the middle of the window, `centred`), and always
 * inside the window (on a phone the button can sit in the middle of the row, where a menu lined up with it would run
 * off the screen). `width`: the menu's, in px.
 */
function menuPlace(button: DOMRect, width: number, centred = false): CSSProperties {
  const w = Math.min(width, window.innerWidth - 16);
  const at = centred ? (window.innerWidth - w) / 2 : button.right - w;
  const left = Math.round(Math.min(Math.max(8, at), window.innerWidth - w - 8));
  const above = button.top;
  const below = window.innerHeight - button.bottom;
  // Taller than the room, it scrolls (the menus are scroll areas).
  return above > below
    ? { left, width: w, bottom: window.innerHeight - button.top + 10, maxHeight: above - 18 }
    : { left, width: w, top: button.bottom + 10, maxHeight: below - 18 };
}

const SLEEP_MINUTES = [15, 30, 45, 60, 90];

/** The sleep timer: playback stops after a while, or at the end of the track. Shows the minutes left while it runs. */
export function SleepButton({ className, size = "sm" }: { className?: string; size?: "sm" | "md" }) {
  const t = useT();
  const sleep = usePlayer((s) => s.sleep);
  const setSleep = usePlayer((s) => s.setSleep);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<CSSProperties>({});
  const [, tick] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  // The minutes left, kept current while the timer runs.
  useEffect(() => {
    if (typeof sleep !== "number") return;
    const timer = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(timer);
  }, [sleep]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const toggle = () => {
    const r = box.current?.getBoundingClientRect();
    if (r && !open) setAt(menuPlace(r, 224));
    setOpen((o) => !o);
  };
  const pick = (v: number | "track" | null) => {
    setSleep(v);
    setOpen(false);
  };
  const left = typeof sleep === "number" ? Math.max(1, Math.ceil((sleep - Date.now()) / 60_000)) : null;
  const status = sleep === "track" ? t.player.sleepAtEnd : left !== null ? t.player.sleepLeft(left) : t.player.sleep;
  const item = (on: boolean) =>
    cn("flex w-full items-center rounded-lg px-3 py-2 text-left text-[13px]", on ? "bg-accent-soft text-accent-text" : "text-fg hover:bg-surface-4");

  return (
    <div ref={box} className={cn("relative flex items-center", className)}>
      <IconButton label={status} size={size} active={sleep !== null || open} onClick={toggle} aria-expanded={open} aria-haspopup="menu">
        <MoonStarsIcon size={size === "md" ? 22 : 18} weight={sleep !== null ? "fill" : "regular"} />
      </IconButton>
      {left !== null && <span className="pointer-events-none absolute -right-1 -bottom-0.5 font-mono text-[10px] text-accent-text">{left}</span>}
      {open && (
        <div role="menu" aria-label={t.player.sleep} style={at} className="scroll-area fixed z-50 overflow-y-auto rounded-2xl bg-surface-3 p-1.5 shadow-lg ring-1 ring-line">
          <p className="px-3 pt-1.5 pb-2 text-[12px] text-fg-3">{status}</p>
          <button type="button" role="menuitemradio" aria-checked={sleep === "track"} className={item(sleep === "track")} onClick={() => pick("track")}>
            {t.player.sleepEndOfTrack}
          </button>
          {SLEEP_MINUTES.map((m) => (
            <button key={m} type="button" role="menuitem" className={item(false)} onClick={() => pick(m)}>
              {t.player.sleepMinutes(m)}
            </button>
          ))}
          {sleep !== null && (
            <button type="button" role="menuitem" className={item(false)} onClick={() => pick(null)}>
              {t.player.sleepOff}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** A quality line as people know it: 4K, 1440p (2K when short), 720p. */
export const qualityLabel = (h: number, short = false) =>
  h >= 2160 ? "4K" : h >= 1440 && short ? "2K" : short ? String(h) : `${h}p`;

/** Offered when the device being controlled can't say which qualities its video has. */
const COMMON_QUALITIES = [1080, 720, 480, 360];

/**
 * The video quality: Auto (SD at once, then what fits the screen) or one of the qualities YouTube has for this video,
 * under the server's limit. Compact: a badge on the switch's corner, so the phone's row doesn't widen.
 */
export function QualityButton({ compact }: { compact: boolean }) {
  const t = useT();
  const remote = usePlayer((s) => !!s.remote);
  const chosen = usePlayer((s) => s.remote?.quality ?? s.quality);
  const playing = usePlayer((s) => s.videoQuality);
  const setQuality = usePlayer((s) => s.setQuality);
  const track = usePlayer(selectCurrent);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<number[] | null>(null);
  const [at, setAt] = useState<CSSProperties>({});
  const box = useRef<HTMLDivElement>(null);
  const toggle = () => {
    const r = box.current?.getBoundingClientRect();
    // On a phone the menu takes most of the width: in the middle of the screen, over the row it opened from.
    if (r && !open) setAt(menuPlace(r, 256, window.innerWidth < 768));
    setOpen((o) => !o);
  };
  const shown = remote ? (chosen === "auto" ? null : chosen) : playing;

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  // The qualities of the video playing here, asked when the menu opens (the server already resolved it).
  useEffect(() => {
    if (!open) return;
    const id = remote ? null : playingVideoId();
    if (!id) return setList(COMMON_QUALITIES);
    let live = true;
    setList(null);
    api.videoQualities(id).then(
      (r) => live && setList([...r.qualities].sort((a, b) => b - a)),
      () => live && setList(COMMON_QUALITIES),
    );
    return () => {
      live = false;
    };
  }, [open, remote, track?.id]);

  const pick = (q: Quality) => {
    setQuality(q);
    setOpen(false);
  };
  const high = (shown ?? 0) >= 720;
  const label = chosen === "auto" ? (shown ? `${t.player.qualityAuto} · ${qualityLabel(shown)}` : t.player.qualityAuto) : qualityLabel(chosen);
  const item = (on: boolean) =>
    cn(
      "flex w-full items-center justify-between gap-6 rounded-lg px-3 py-2 text-left text-[13px]",
      on ? "bg-accent-soft text-accent-text" : "text-fg hover:bg-surface-4",
    );

  return (
    <div ref={box} className={cn(compact ? "absolute -top-2.5 -right-2.5" : "relative")}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="menu"
        title={t.player.quality}
        className={cn(
          "rounded-full font-mono font-semibold whitespace-nowrap ring-1 transition-colors",
          compact
            ? cn("h-5 px-1.5 text-[10px] leading-none", high ? "bg-accent text-accent-ink ring-accent" : "bg-surface-2 text-fg-2 ring-line")
            : cn("h-9 px-3 text-[12px]", high ? "bg-accent-soft text-accent-text ring-accent/40" : "text-fg-2 ring-line hover:text-fg"),
        )}
      >
        {compact ? (
          shown ? qualityLabel(shown, true) : "A"
        ) : (
          <>
            <span className="max-md:hidden">{label}</span>
            {/* A phone's cinema view has less room beside the controls: just the quality playing. */}
            <span className="md:hidden">{shown ? qualityLabel(shown) : t.player.qualityAuto}</span>
          </>
        )}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t.player.quality}
          style={at}
          className="scroll-area fixed z-50 overflow-y-auto rounded-2xl bg-surface-3 p-1.5 shadow-lg ring-1 ring-line"
        >
          <button type="button" role="menuitemradio" aria-checked={chosen === "auto"} className={item(chosen === "auto")} onClick={() => pick("auto")}>
            <span className="flex flex-col">
              <span className="font-medium">{t.player.qualityAuto}</span>
              <span className="text-[11px] text-fg-3">{t.player.qualityAutoHint}</span>
            </span>
            {chosen === "auto" && shown ? <span className="font-mono text-[11px]">{qualityLabel(shown)}</span> : null}
          </button>
          {list === null ? (
            <div className="px-3 py-2 text-[12px] text-fg-3">…</div>
          ) : (
            list.map((h) => (
              <button key={h} type="button" role="menuitemradio" aria-checked={chosen === h} className={item(chosen === h)} onClick={() => pick(h)}>
                <span className="font-mono">{qualityLabel(h)}</span>
                {h !== 360 && <span className="text-[11px] text-fg-3">{t.player.qualityDownloads}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** Audio / Video segmented switch. For songs, Video plays the song's music video when YouTube has one. */
const noLink = () => () => {};

/**
 * Whether video can play: on this device (a phone's server out of reach means audio only, so it follows the server
 * coming and going), or on the device it controls.
 */
export function useVideoAvailable(): boolean {
  useSyncExternalStore(link?.subscribe ?? noLink, () => link?.online ?? true);
  return usePlayer((s) => s.remote?.video ?? capabilities.video);
}

/** `compact`: icons only, for the row at the bottom of the phone's sheet. */
export function ModeSwitch({ className, compact = false }: { className?: string; compact?: boolean }) {
  const t = useT();
  // This device's mode, or the one of the device it controls (which may not play videos: the phone's own library).
  const preferVideo = usePlayer((s) => s.remote?.preferVideo ?? s.preferVideo);
  const setPreferVideo = usePlayer((s) => s.setPreferVideo);
  const showingVideo = usePlayer((s) => s.remote?.showingVideo ?? s.mediaKind === "video");
  const canVideo = useVideoAvailable();
  if (!canVideo) return null;

  const seg = (on: boolean) =>
    cn(
      "flex items-center gap-1.5 rounded-full text-[13px] font-medium transition-colors duration-200",
      compact ? "size-8 justify-center" : "h-9 px-3.5",
      on ? "bg-surface-4 text-fg shadow-[inset_0_1px_0_var(--highlight)]" : "text-fg-2 hover:text-fg",
    );

  return (
    // Compact, the quality is a badge on the switch's corner, so it doesn't widen the row it sits in.
    <div className={cn("flex items-center", compact ? "relative" : "gap-2", className)}>
      <div role="radiogroup" aria-label={t.player.mode} className="flex rounded-full bg-surface-1 p-1 ring-1 ring-line">
        <button
          type="button"
          role="radio"
          aria-checked={!preferVideo}
          aria-label={compact ? t.player.audio : undefined}
          title={compact ? t.player.audio : undefined}
          className={seg(!preferVideo)}
          onClick={() => setPreferVideo(false)}
        >
          <MusicNotesIcon size={compact ? 17 : 15} /> {!compact && t.player.audio}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={preferVideo}
          aria-label={compact ? t.player.video : undefined}
          className={seg(preferVideo)}
          onClick={() => setPreferVideo(true)}
          title={t.player.watchClip}
        >
          <VideoCameraIcon size={compact ? 17 : 15} /> {!compact && t.player.video}
        </button>
      </div>
      {showingVideo && <QualityButton compact={compact} />}
    </div>
  );
}
