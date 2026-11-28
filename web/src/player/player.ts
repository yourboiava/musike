import { create } from "zustand";
import { getT, useT } from "../i18n";
import { api, capabilities, explainStreamError, link, streamSource, systemMedia, type ApiError, type ErrorCode } from "../lib/api";
import { createAudio } from "../lib/audio";
import { desktop } from "../lib/desktop";
import { shuffled } from "../lib/format";
import type { Track } from "../lib/types";
import { useLibrary } from "../stores/library";
import { openSettings } from "../stores/system";
import { toast } from "../stores/ui";

export type Repeat = "off" | "all" | "one";
/** A code translated where it is shown (so switching languages updates it), or a server error already in the right language. */
export type StatusNote = "findingClip" | "preparingHd" | "loadingVideo" | "fetchingRadio" | { error: string };
export type Status = "idle" | "loading" | "playing" | "paused" | "error";
type Kind = "audio" | "video";
/** The video quality: "auto", or a quality line YouTube offers (e.g. 720). */
export type Quality = "auto" | number;

/** A saved or received quality: the older "sd" is Auto, "hd" is 720. */
export function toQuality(v: unknown): Quality {
  if (v === "hd") return 720;
  if (typeof v === "number" && Number.isInteger(v) && v >= 144 && v <= 4320) return v;
  return "auto";
}

/** The ready-made SD stream's quality: what Auto starts with, because it plays at once. */
export const SD = 360;

/**
 * Another device of the account plays, and this one shows it and controls it, Spotify-style (stores/devices.ts
 * keeps it up to date). The player's buttons and "play" anywhere in the app go there instead.
 */
export interface RemoteView {
  device: string;
  name: string;
  track: Track | null;
  playing: boolean;
  /** Where the track is now (kept moving while it plays). */
  position: number;
  duration: number;
  shuffle: boolean;
  repeat: Repeat;
  volume: number;
  muted: boolean;
  /** It can play videos (the phone's own library can't). */
  video: boolean;
  preferVideo: boolean;
  quality: Quality;
  showingVideo: boolean;
  autoRadio: boolean;
  /** Its browser waits for a click on it before playing (after a reload). */
  blocked: boolean;
  /** Its queue (up to 500 tracks around the current one) and the current track in it. */
  queue: Track[];
  index: number;
}

/** What the controlling device sends (see stores/devices.ts). */
export interface RemoteControl {
  play(): void;
  pause(): void;
  next(): void;
  prev(): void;
  seek(seconds: number): void;
  toggleShuffle(): void;
  cycleRepeat(): void;
  playList(tracks: Track[], start: number): void;
  playTrack(track: Track): void;
  playNext(track: Track): void;
  addToQueue(track: Track): void;
  startRadio(track: Track): void;
  setVolume(volume: number): void;
  toggleMute(): void;
  setPreferVideo(on: boolean): void;
  setQuality(quality: Quality): void;
  /** Positions in RemoteView.queue. */
  jumpTo(index: number): void;
  removeAt(index: number): void;
  /** A track of up next to another place in it. */
  moveTo(from: number, to: number): void;
  clearUpcoming(): void;
  setAutoRadio(on: boolean): void;
}

let remoteControl: RemoteControl | null = null;
let localOnly = 0;

/** stores/devices.ts: where commands go while `remote` is set. */
export function setRemoteControl(control: RemoteControl | null) {
  remoteControl = control;
}

/** Runs `fn` on this device's own player, even while it controls another one: for commands from other devices. */
export function locally<T>(fn: () => T): T {
  localOnly++;
  try {
    return fn();
  } finally {
    localOnly--;
  }
}

interface PlayerState {
  /** Set while this device controls another one (see RemoteView). */
  remote: RemoteView | null;
  queue: Track[];
  /** Queue order before shuffle was turned on, restored when it is turned off. */
  original: Track[] | null;
  index: number;
  status: Status;
  /** What playback is busy with (or why it failed), shown instead of the artist. See `useStatusText`. */
  statusText: StatusNote | null;
  /**
   * The browser refused to play: a page plays sound only after someone clicked on it, so after a reload a command from
   * another device can't start it. A click on the button that shows meanwhile plays (see AutoplayPrompt).
   */
  blocked: boolean;
  /** Plays what the browser refused, from a click (the click is what the browser waits for). */
  unblock: () => void;
  /** Which media element is driving playback right now. */
  mediaKind: Kind;
  /** Set when Video mode is on but the current song has no music video on YouTube. */
  videoNote: "noClip" | null;
  /** Intrinsic width/height of the current video, so vertical videos get a vertical stage. */
  videoAspect: number;
  position: number;
  duration: number;
  buffered: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: Repeat;
  preferVideo: boolean;
  quality: Quality;
  /** The quality line the video plays in now (Auto starts at 360 and rises when the video is shown big). */
  videoQuality: number;
  autoRadio: boolean;

  playList: (tracks: Track[], start?: number) => void;
  playTrack: (track: Track) => void;
  playNext: (track: Track) => void;
  addToQueue: (track: Track) => void;
  removeAt: (i: number) => void;
  jumpTo: (i: number) => void;
  clearUpcoming: () => void;
  /** The tracks after the current one, in a new order (dragged in the queue). This device only. */
  reorderUpcoming: (tracks: Track[]) => void;
  /**
   * One track of up next to another place in it (positions in the queue shown: this device's, or the one of the
   * device it controls, where the move is sent).
   */
  moveInQueue: (from: number, to: number) => void;
  startRadio: (track: Track) => Promise<void>;
  toggle: () => void;
  /** Stops, without toggling: another device of the account took over. A track still loading won't start. */
  pause: () => void;
  next: () => void;
  prev: () => void;
  seek: (seconds: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setPreferVideo: (on: boolean) => void;
  setQuality: (q: Quality) => void;
  setAutoRadio: (on: boolean) => void;
  /**
   * The sleep timer: when playback stops by itself (ms since epoch), "track" at the end of the track playing, or
   * null when it's off.
   */
  sleep: number | "track" | null;
  /** The same volume for every track: loud ones are turned down to YouTube's reference level. */
  evenVolume: boolean;
  setEvenVolume: (on: boolean) => void;
  /** Stops playback in `minutes`, at the end of this track ("track"), or turns the timer off (null). */
  setSleep: (minutes: number | "track" | null) => void;
  /** Another device hands its playback over: its queue, from where it was, playing. */
  takeOver: (queue: Track[], index: number, position: number, shuffle: boolean, repeat: Repeat) => void;
}

// Media elements live outside React so playback survives any re-render or route change.
// On iOS this is the native player behind the same API (see lib/audio.ts).
const audio = createAudio();

function makeVideo(): HTMLVideoElement {
  const v = document.createElement("video");
  v.playsInline = true;
  v.preload = "auto";
  v.setAttribute("playsinline", "");
  v.className = "absolute inset-0 block h-full w-full object-contain bg-black";
  return v;
}

/**
 * Two <video> elements, one over the other: the one playing (`videoEl`), and one where another quality of the same
 * video gets ready, hidden, to take over without a gap (see swapQuality).
 */
const videos = [makeVideo(), makeVideo()] as const;
export let videoEl: HTMLVideoElement = videos[0];
const standbyVideo = () => (videoEl === videos[0] ? videos[1] : videos[0]);
/** What the video slots show (components/Video.tsx moves it around the page): the two <video> elements. */
export const videoBox = document.createElement("div");
// Its own stacking context: the two <video>s' order stays inside, under whatever a slot puts over the video.
videoBox.className = "relative isolate h-full w-full bg-black";
videoBox.append(...videos);
/** The one playing in front; the other one invisible behind it (still decoding, so it's ready when it takes over). */
function showPlaying() {
  for (const v of videos) {
    v.style.opacity = v === videoEl ? "1" : "0";
    v.style.zIndex = v === videoEl ? "1" : "0";
  }
}
showPlaying();

const mediaFor = (k: Kind): HTMLMediaElement => (k === "video" ? videoEl : audio);

let loaded: { id: string; kind: Kind; height: number; media: string } | null = null;

/** The YouTube id of the video playing here (a song's music video in Video mode), or null. */
export const playingVideoId = (): string | null => (loaded?.kind === "video" ? loaded.media : null);
/**
 * Auto: a video starts in SD (it plays at once) and, shown bigger than SD looks good at (cinema view, full screen, a
 * wide window), the quality that fits is downloaded in the background and takes over from where SD was. The quality
 * fetched for each video, so it stays when the view gets small again.
 */
const fetchedFor = new Map<string, number>();
/** How tall the video shows on screen (CSS pixels), measured by the observer after the store. */
let shownHeight = 0;
let fetching: string | null = null;
/**
 * Whether each video has YouTube's ready-made SD stream, learnt when it's resolved ahead: without one, even SD is a
 * download (and nothing can play meanwhile).
 */
const sdFor = new Map<string, boolean>();
/** The playing track's own download of its quality, while it runs: the next track's waits for it to be done. */
let hdPending: Promise<unknown> | null = null;
/** How long a quality may take to be ready before SD plays meanwhile: a file already in the cache answers sooner. */
const HD_GRACE_MS = 1200;
/** Skips closer together than this, in Video mode, are a skipping-through: only where it stops is loaded. */
const SKIP_BURST_MS = 1200;
/** How long the skipping has to pause for the track it stopped on to load. */
const SKIP_SETTLE_MS = 450;
/** How far ahead of the picture the next quality gets ready, to take over when the picture gets there. */
const SWAP_LEAD_S = 1.5;
/** How many tracks of the queue are got ready ahead. */
const AHEAD = 2;
/** Told by the video's size on screen. */
let onShown: (height: number) => void = () => {};
let sleepTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Each track's volume factor for the even volume: YouTube says how many dB louder than its reference a track is, and
 * a louder one is turned down by as much (a quieter one can't go above full volume). Known before the track starts
 * when it comes next in the queue.
 */
const gains = new Map<string, number>();
const gainFrom = (db: number | null) => (db && db > 0 ? Math.max(0.2, 10 ** (-db / 20)) : 1);
let pendingSeek = 0;
let token = 0;
/** YouTube's bot check (see botCheck): until when video waits, the retries left for audio and their timer. */
let videoBlockedUntil = 0;
let botRetries = 0;
let botTimer: ReturnType<typeof setTimeout> | undefined;
const BOT_RETRY_MINUTES = [1, 3];
/** The load that has started playing (warming the next track, and telling a pause mid-buffering from one at start). */
let recordedToken = -1;

/** A play counts (history, play log) once it has really played this long, or half a shorter track: like Spotify. */
const PLAY_COUNTS_AFTER = 30;
/** The track being listened to, and for how long it has actually played (seeks don't count). */
let listening = { key: "", seconds: 0, last: -1, counted: false };

const STORAGE_KEY = "musike:player";

interface Saved {
  evenVolume: boolean;
  queue: Track[];
  original: Track[] | null;
  index: number;
  position: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: Repeat;
  preferVideo: boolean;
  quality: Quality;
  autoRadio: boolean;
}

function readSaved(): Partial<Saved> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Saved>;
  } catch {
    return {};
  }
}

const saved = readSaved();

/**
 * Songs from YouTube Music are "art tracks": audio with a still cover. In Video mode we play the
 * song's music video instead. Song id → video id, or null when YouTube has no clip for it.
 */
const clipFor = new Map<string, string | null>();
const clipLookups = new Map<string, Promise<string | null>>();

function lookupClip(track: Track): Promise<string | null> {
  if (track.kind === "video") return Promise.resolve(track.id);
  if (clipFor.has(track.id)) return Promise.resolve(clipFor.get(track.id)!);
  let lookup = clipLookups.get(track.id);
  if (!lookup) {
    lookup = api
      .videoFor(track)
      .then(
        (v) => {
          const id = v?.id ?? null;
          clipFor.set(track.id, id);
          return id;
        },
        () => null, // network hiccup: don't remember it, try again next time
      )
      .finally(() => clipLookups.delete(track.id));
    clipLookups.set(track.id, lookup);
  }
  return lookup;
}

// Video mode only counts where video can play (a phone whose server is out of reach plays audio).
const needsClipLookup = (track: Track, preferVideo: boolean) =>
  preferVideo && capabilities.video && track.kind === "song" && !clipFor.has(track.id);

/** No progress for this long while it should play: treated like a stream error. */
const STALL_MS = 20_000;
/** Connected to a server, after this long the server is checked: gone, the stream comes from the phone at once. */
const STALL_CHECK_MS = 6000;

export const usePlayer = create<PlayerState>((set, get) => {
  /** Where an action goes instead of this device's player: the device being controlled, if any. */
  const elsewhere = () => (!localOnly && get().remote ? remoteControl : null);

  const kindFor = (track: Track): Kind =>
    capabilities.video &&
    get().preferVideo &&
    Date.now() > videoBlockedUntil &&
    (track.kind === "video" || !!clipFor.get(track.id))
      ? "video"
      : "audio";
  /** The YouTube id to stream: the song itself, or its music video in Video mode. */
  const mediaIdFor = (track: Track, kind: Kind) =>
    kind === "video" && track.kind !== "video" ? clipFor.get(track.id)! : track.id;
  /** The quality line a video plays in: the chosen one, or with Auto SD (and what was fetched for the big screen). */
  const heightOf = (track: Track, kind: Kind): number => {
    const q = get().quality;
    if (q !== "auto") return q;
    return kind === "video" ? Math.max(SD, fetchedFor.get(mediaIdFor(track, kind)) ?? 0) : SD;
  };
  const noteFor = (track: Track) =>
    get().preferVideo && capabilities.video && track.kind === "song" && clipFor.get(track.id) === null
      ? ("noClip" as const)
      : null;
  const activeMedia = (): HTMLMediaElement | null => (loaded ? mediaFor(loaded.kind) : null);

  /** The volume chosen, times the playing track's factor when the volume is evened out. */
  const applyVolume = () => {
    const s = get();
    const gain = s.evenVolume && loaded ? (gains.get(loaded.media) ?? 1) : 1;
    audio.volume = videoEl.volume = s.volume * gain;
  };
  /** Asks for a track's loudness once, and evens the volume when it's the one playing. */
  const learnGain = (id: string) => {
    if (gains.has(id) || !get().evenVolume) return;
    gains.set(id, 1); // asked once
    api.loudness(id).then(
      (db) => {
        gains.set(id, gainFrom(db));
        if (loaded?.media === id) applyVolume();
      },
      () => gains.delete(id),
    );
  };

  function play(media: HTMLMediaElement) {
    media.play().catch((err: DOMException) => {
      if (err.name === "AbortError") return; // src changed mid-start
      if (err.name === "NotAllowedError") set({ status: "paused", blocked: true }); // autoplay blocked: needs a click here
    });
  }

  /** The server work for the track loading (its quality's download): given up when another track loads. */
  let loadWork = new AbortController();
  /** Skipping through in Video mode: the track it stopped on loads after this (see skipTo). */
  let settle: ReturnType<typeof setTimeout> | undefined;
  let lastSkip = 0;

  function load(index: number, opts: { autoplay?: boolean; startAt?: number } = {}) {
    clearTimeout(settle);
    const s = get();
    const track = s.queue[index];
    if (!track) return;
    loadWork.abort();
    loadWork = new AbortController();
    const signal = loadWork.signal;
    cancelSwap();

    // Video mode on a song: find its music video first, then load whichever fits.
    if (needsClipLookup(track, s.preferVideo)) {
      const mine = ++token;
      set({
        index,
        status: "loading",
        statusText: "findingClip",
        videoNote: null,
        position: opts.startAt ?? 0,
        duration: track.duration,
        buffered: 0,
      });
      activeMedia()?.pause();
      setMetadata(track);
      void lookupClip(track).then(() => mine === token && load(index, opts));
      return;
    }

    const kind = kindFor(track);
    const media = mediaFor(kind);
    const other = mediaFor(kind === "video" ? "audio" : "video");
    other.pause();
    if (other.getAttribute("src")) {
      other.removeAttribute("src");
      other.load();
    }

    token++;
    const height = heightOf(track, kind);
    const id = mediaIdFor(track, kind);
    const mine = (loaded = { id: track.id, kind, height, media: id });
    /** Still this load: not replaced by another, nor dropped by a pause before it started. */
    const live = () => loaded === mine;
    // The server downloads the quality first (and SD too, for a video without YouTube's ready-made SD stream).
    const download = kind === "video" && (height !== SD || sdFor.get(id) === false);
    pendingSeek = opts.startAt ?? 0;
    // The same track again from where it was (a retry, Audio/Video switched): the same play. Anything else is a new one.
    const key = `${index}:${track.id}`;
    if (key !== listening.key || !(pendingSeek > 0)) listening = { key, seconds: 0, last: -1, counted: false };
    const autoplay = opts.autoplay !== false;
    set({
      index,
      mediaKind: kind,
      status: autoplay ? "loading" : "paused",
      // Video may need a server-side download first (HD, or videos without a combined SD stream).
      statusText: kind === "video" ? (download ? "preparingHd" : "loadingVideo") : null,
      videoQuality: height,
      videoNote: noteFor(track),
      position: pendingSeek,
      duration: track.duration,
      buffered: 0,
    });
    media.muted = s.muted;
    applyVolume();
    if (kind === "audio") learnGain(loaded.media);
    const start = (src: string) => {
      media.src = src;
      lastProgress = Date.now();
      if (autoplay) play(media);
    };
    const begin = (h: number) => {
      // The server's proxy URL is known right away; on Android the stream is first resolved on the phone.
      const source = streamSource(mediaIdFor(track, kind), kind, h);
      if (typeof source === "string") start(source);
      else
        source.then(
          (src) => live() && start(src),
          (err: ApiError) => live() && report(err.message, err.code),
        );
    };
    const playsIn = (h: number) => {
      mine.height = h;
      set({ videoQuality: h });
    };
    if (download) {
      // Asked ahead rather than streamed, so the player doesn't sit on a request with no data and take it for a
      // stall. Already in the cache (fetched ahead while the last track played), the quality answers in a moment and
      // plays straight away; otherwise SD, which starts at once, plays meanwhile and the quality takes over without a
      // gap when it's there (swapQuality). If it can't be had, SD plays on instead of skipping the track.
      const sdMeanwhile = height !== SD && sdFor.get(id) !== false;
      let onSd = false;
      const toSd = () => {
        onSd = true;
        playsIn(SD);
        set({ statusText: "loadingVideo" });
        begin(SD);
      };
      const timer = sdMeanwhile ? setTimeout(() => live() && toSd(), HD_GRACE_MS) : undefined;
      const job = api.prepareVideo(id, height, signal);
      hdPending = job;
      job
        .then(
          (real) => {
            clearTimeout(timer);
            if (!live()) return;
            if (onSd) return swapQuality(real);
            playsIn(real);
            begin(real);
          },
          (err: ApiError) => {
            clearTimeout(timer);
            if (!live() || signal.aborted) return;
            if (!onSd && (err.code === "bot_check" || height === SD)) return report(err.message, err.code);
            toast(getT().player.qualityFailed);
            if (!onSd) toSd();
          },
        )
        .finally(() => {
          if (hdPending === job) hdPending = null;
        });
    } else begin(height);
    setMetadata(track);
    if (kind === "video") fitToScreen();
  }

  /** A quality getting ready in the hidden <video> (swapQuality). */
  let swap: { cancel: () => void } | null = null;
  function cancelSwap() {
    swap?.cancel();
    swap = null;
  }

  /**
   * Another quality of the video playing takes over without a gap: it loads in the hidden <video>, a little ahead of
   * where the picture is, and when the playing one gets there the two trade places, the sound along with them.
   * Paused, it takes over at once on the same frame. If it doesn't get ready, the current quality just plays on.
   */
  function swapQuality(height: number) {
    cancelSwap();
    const mine = loaded;
    if (!mine || mine.kind !== "video") return;
    if (mine.height === height && videoEl.getAttribute("src")) return;
    const from = videoEl;
    const to = standbyVideo();
    let finished = false;
    let tick: ReturnType<typeof setTimeout> | undefined;
    let target = 0;
    const finish = (took: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(giveUp);
      clearTimeout(tick);
      to.removeEventListener("seeked", onSeeked);
      to.removeEventListener("canplay", onSeeked);
      to.removeEventListener("error", onError);
      if (!took) {
        to.pause();
        to.removeAttribute("src");
        to.load();
      }
      if (swap === handle) swap = null;
    };
    const handle = { cancel: () => finish(false) };
    swap = handle;
    const giveUp = setTimeout(() => finish(false), 30_000);
    const onError = () => finish(false);
    // With the page hidden (screen off, another tab) timers run once a second: a shorter lead, a wider window, and only
    // the sound to keep in step.
    const lead = () => (document.hidden ? 0.4 : SWAP_LEAD_S);
    /** Gets ready where the picture will be in a moment (where it is, paused). */
    const aim = () => {
      target = from.paused ? from.currentTime : from.currentTime + lead();
      to.currentTime = target;
    };
    const commit = () => {
      if (loaded !== mine) return finish(false);
      const playing = !from.paused;
      videoEl = to;
      showPlaying();
      to.muted = get().muted;
      applyVolume();
      if (playing) play(to);
      from.pause();
      from.removeAttribute("src");
      from.load();
      mine.height = height;
      set({ videoQuality: height, ...(to.videoWidth && to.videoHeight ? { videoAspect: to.videoWidth / to.videoHeight } : {}) });
      finish(true);
    };
    /** Ready where it aimed: takes over when the picture reaches that point; aims again if the picture jumped. */
    const watch = () => {
      if (finished) return;
      if (loaded !== mine) return finish(false);
      if (to.seeking || to.readyState < 3) return; // on its way (seeked or canplay comes)
      const gap = target - from.currentTime;
      const late = document.hidden ? -1.2 : -0.25;
      if (from.paused) return Math.abs(gap) < 0.05 ? commit() : aim();
      if (gap <= 0.03 && gap > late) return commit();
      if (gap <= late || gap > lead() + 1) return aim(); // seeked meanwhile, or this one was too slow
      tick = setTimeout(watch, 15);
    };
    const onSeeked = () => watch();
    to.addEventListener("seeked", onSeeked);
    to.addEventListener("canplay", onSeeked);
    to.addEventListener("error", onError);
    to.addEventListener("loadedmetadata", () => !finished && aim(), { once: true });
    to.muted = true;
    const source = streamSource(mine.media, "video", height);
    if (typeof source === "string") to.src = source;
    else source.then((src) => !finished && (to.src = src), () => finish(false));
  }

  /**
   * Another quality chosen while the video plays: the picture goes on in the current one while the new one downloads,
   * then the new one takes over without a gap.
   */
  function changeQuality() {
    const mine = loaded;
    const q = get().quality;
    if (!mine || mine.kind !== "video") return;
    if (q === "auto") return fitToScreen();
    if (q === mine.height) return;
    const ready = q <= SD && sdFor.get(mine.media) !== false ? Promise.resolve(SD) : api.prepareVideo(mine.media, q, loadWork.signal);
    ready.then(
      (real) => loaded === mine && real !== mine.height && swapQuality(real),
      () => loaded === mine && !loadWork.signal.aborted && toast(getT().player.qualityFailed),
    );
  }

  /** Stops what's loading or playing here, without starting anything: skipping through, a track is only shown. */
  function stopLoading() {
    token++;
    loadWork.abort();
    cancelSwap();
    loaded = null;
    for (const media of [audio, ...videos]) {
      media.pause();
      if (media.getAttribute("src")) {
        media.removeAttribute("src");
        media.load();
      }
    }
  }

  /**
   * Next or previous. In Video mode every track loaded starts a clip lookup and a download on the server, so skips
   * close together are a skipping-through: each track shows at once, and only the one it stops on loads.
   */
  function skipTo(index: number) {
    const s = get();
    const track = s.queue[index];
    if (!track) return;
    const now = Date.now();
    const burst = now - lastSkip < SKIP_BURST_MS;
    lastSkip = now;
    if (!burst || !(s.preferVideo && capabilities.video)) return load(index);
    stopLoading();
    set({ index, status: "loading", statusText: null, videoNote: null, position: 0, duration: track.duration, buffered: 0 });
    setMetadata(track);
    clearTimeout(settle);
    settle = setTimeout(() => load(get().index), SKIP_SETTLE_MS);
  }

  /**
   * Auto, with the video shown bigger than it plays: the quality that fits (the lowest at least as tall as the video
   * shows, under the server's limit) downloads in the background, then plays from where the current one is.
   */
  function fitToScreen() {
    const s = get();
    const track = s.queue[s.index];
    if (s.quality !== "auto" || !track || elsewhere() || loaded?.id !== track.id || loaded.kind !== "video") return;
    if (shownHeight <= loaded.height * 1.15) return;
    const id = mediaIdFor(track, "video");
    if (fetching === id) return;
    fetching = id;
    const wanted = shownHeight;
    api
      .videoQualities(id)
      .then(async ({ qualities }) => {
        const fits = qualities.find((h) => h >= wanted) ?? qualities[qualities.length - 1];
        if (!fits || !loaded || fits <= loaded.height) return;
        const mine = loaded;
        const job = api.prepareVideo(id, fits, loadWork.signal);
        hdPending = job;
        const real = await job.finally(() => {
          if (hdPending === job) hdPending = null;
        });
        fetchedFor.set(id, real);
        if (get().quality !== "auto" || loaded !== mine || mine.height >= real) return;
        swapQuality(real);
      })
      .catch(() => {}) // the better quality didn't come: the current one goes on
      .finally(() => {
        if (fetching === id) fetching = null;
      });
  }
  onShown = (height) => {
    shownHeight = height;
    fitToScreen();
  };

  /** The sleep timer runs out: the music fades over a few seconds, then pauses, and the volume comes back. */
  function asleep() {
    clearTimeout(sleepTimer);
    set({ sleep: null });
    const media = activeMedia();
    if (elsewhere() || !media || media.paused) return get().pause();
    const from = media.volume;
    const steps = 16;
    let step = 0;
    const fade = setInterval(() => {
      step++;
      media.volume = from * (1 - step / steps);
      if (step < steps) return;
      clearInterval(fade);
      get().pause();
      applyVolume();
    }, 6000 / steps);
  }

  async function continueWithRadio() {
    const s = get();
    const last = s.queue[s.index];
    if (!last) return;
    set({ status: "loading", statusText: "fetchingRadio" });
    const mine = token;
    try {
      const known = new Set(get().queue.map((t) => t.id));
      const more = (await api.radio(last.id)).filter((t) => !known.has(t.id)).slice(0, 25);
      if (mine !== token) return; // paused (or another track started) meanwhile
      if (!more.length) throw new Error("empty");
      set((st) => ({
        queue: [...st.queue, ...more],
        original: st.original ? [...st.original, ...more] : null,
      }));
      toast(getT().player.radioContinuing(last.title));
      load(get().index + 1);
    } catch {
      if (mine !== token) return;
      set({ status: "paused", statusText: null, position: 0 });
    }
  }

  /**
   * Gets what comes next ready while this track plays, so it starts at once: the next tracks' audio fetched into the
   * server's cache; in Video mode their music videos looked up, and the very next one resolved (is it there, can it
   * play, has it a ready-made SD stream) and downloaded in the quality it will play in.
   */
  /** What's fetched ahead for the next tracks: given up when the queue moves on. */
  let warmWork = new AbortController();

  function warmUpcoming() {
    warmWork.abort();
    warmWork = new AbortController();
    const s = get();
    const next = s.queue.slice(s.index + 1, s.index + 1 + AHEAD);
    const video = s.preferVideo && capabilities.video && Date.now() > videoBlockedUntil;
    next.forEach((track, k) => {
      if (!video) return warmAudio(track);
      void lookupClip(track).then((clip) => {
        if (!clip) return warmAudio(track); // no music video: it will play as audio
        if (k === 0) warmVideo(track, clip);
      });
    });
  }

  function warmAudio(track: Track) {
    // An older server without the cache: the stream at least resolved ahead.
    api.prefetchAudio(track.id).catch(() => api.prepare(track.id).catch(() => {}));
    learnGain(track.id);
  }

  function warmVideo(track: Track, clip: string) {
    const signal = warmWork.signal;
    api
      .prepare(clip)
      .then(
        async (p) => {
          sdFor.set(clip, p.hasSdVideo);
          const q = get().quality;
          // Auto plays the next video as big as this one got. SD needs nothing more, unless it's a download too.
          const want = q !== "auto" ? q : loaded?.kind === "video" ? Math.max(SD, loaded.height) : SD;
          const need = want !== SD ? want : p.hasSdVideo ? 0 : SD;
          if (!need) return;
          // After this track's own download: one at a time, each is done sooner.
          await hdPending?.catch(() => {});
          if (signal.aborted) return;
          const real = await api.prepareVideo(clip, need, signal);
          if (get().quality === "auto") fetchedFor.set(clip, real);
        },
        (err: ApiError) => {
          // A clip that can't play (removed, private, age-restricted): its song plays as audio, instead of failing on it.
          if (track.kind === "song" && (err.status === 403 || err.status === 404)) {
            clipFor.set(track.id, null);
            warmAudio(track);
          }
        },
      )
      .catch(() => {});
  }

  function onStarted() {
    const s = get();
    const track = s.queue[s.index];
    if (!track || recordedToken === token) return;
    recordedToken = token;
    warmUpcoming();
  }

  /** Playing on: the time it really played adds up, and past the threshold the play is recorded, once. */
  function listened(media: HTMLMediaElement) {
    const now = media.currentTime;
    const step = now - listening.last;
    listening.last = now;
    if (listening.counted || media.paused || !(step > 0 && step < 1.5)) return;
    listening.seconds += step;
    const s = get();
    const track = s.queue[s.index];
    if (!track || listening.key !== `${s.index}:${track.id}`) return;
    const length = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : track.duration;
    if (listening.seconds < (length > 0 ? Math.min(PLAY_COUNTS_AFTER, length / 2) : PLAY_COUNTS_AFTER)) return;
    listening.counted = true;
    useLibrary.getState().recordPlay(track);
  }

  function onEnded() {
    const s = get();
    if (s.sleep === "track") return asleep();
    if (s.repeat === "one") {
      const media = activeMedia();
      if (media) {
        media.currentTime = 0;
        play(media);
      }
      return;
    }
    if (s.index < s.queue.length - 1) return load(s.index + 1);
    if (s.repeat === "all" && s.queue.length) return load(0);
    if (s.autoRadio) return void continueWithRadio();
    set({ status: "paused", position: 0 });
  }

  /** Shows why a track can't play, then moves on (unless every track would fail the same way). */
  function report(message: string, code?: ErrorCode) {
    if (code === "bot_check") return botCheck(message);
    const mine = token;
    set({ status: "error", statusText: { error: message } });
    const track = get().queue[get().index];
    // Tool problems hit every track: offer the fix instead of skipping through the whole queue.
    const toolProblem = code === "tool_missing" || code === "maybe_outdated";
    const t = getT();
    toast(
      t.player.cantPlay(track?.title ?? t.player.aTrack, message),
      "error",
      toolProblem ? { label: code === "tool_missing" ? t.common.install : t.common.update, run: openSettings } : undefined,
    );
    if (code !== "tool_missing" && get().index < get().queue.length - 1) {
      setTimeout(() => mine === token && get().next(), 2500);
    }
  }

  /**
   * YouTube asking this connection to prove it's not a bot. Every track would hit it, and each new try makes it stick,
   * so never skip through the queue. Video (the server's yt-dlp) waits 10 minutes and the song plays as audio, which
   * comes another way and usually still works. Audio stops on this track and tries it again in 1, then 3 minutes.
   */
  function botCheck(message: string) {
    const t = getT();
    const s = get();
    if (s.mediaKind === "video") {
      videoBlockedUntil = Date.now() + 10 * 60_000;
      toast(t.player.videoBotCheck);
      return load(s.index, { startAt: s.position, autoplay: true });
    }
    const mine = token;
    const wait = BOT_RETRY_MINUTES[botRetries];
    set({ status: "error", statusText: { error: wait ? `${message} ${t.player.botRetry(wait)}` : message } });
    const track = s.queue[s.index];
    toast(t.player.cantPlay(track?.title ?? t.player.aTrack, message), "error", {
      label: t.common.retry,
      run: () => load(get().index, { autoplay: true }),
    });
    clearTimeout(botTimer);
    if (!wait) return;
    botRetries++;
    botTimer = setTimeout(() => mine === token && load(get().index, { autoplay: true }), wait * 60_000);
  }

  // A stream URL that expired mid-song gets one fresh try from the same spot before giving up.
  let retriedToken = -1;
  /** When the playing stream last moved (see the stall check below). */
  let lastProgress = Date.now();

  function onError(media: HTMLMediaElement) {
    const mine = token;
    const url = media.currentSrc || media.src;
    if (capabilities.retryOnError && retriedToken !== mine) {
      const at = media.currentTime || get().position;
      load(get().index, { startAt: at, autoplay: true });
      retriedToken = token;
      return;
    }
    set({ status: "error" });
    explainStreamError(url, media.error).then(({ message, code }) => {
      if (mine === token) report(message, code);
    });
  }

  function wire(media: HTMLMediaElement) {
    const isActive = () => activeMedia() === media;
    media.addEventListener("loadedmetadata", () => {
      if (!isActive()) return;
      if (pendingSeek > 0) {
        media.currentTime = pendingSeek;
        pendingSeek = 0;
      }
      if (Number.isFinite(media.duration)) set({ duration: media.duration });
      if (media === videoEl && videoEl.videoWidth && videoEl.videoHeight) {
        set({ videoAspect: videoEl.videoWidth / videoEl.videoHeight });
      }
      syncPositionState();
    });
    media.addEventListener("durationchange", () => {
      if (isActive() && Number.isFinite(media.duration)) set({ duration: media.duration });
    });
    media.addEventListener("playing", () => {
      if (!isActive()) return;
      botRetries = 0;
      set({ status: "playing", statusText: null, blocked: false });
      onStarted();
      syncPlaybackState();
    });
    media.addEventListener("pause", () => {
      if (!isActive() || media.ended || get().status === "loading" || get().status === "error") return;
      set({ status: "paused" });
      syncPlaybackState();
    });
    media.addEventListener("waiting", () => {
      if (isActive() && !media.paused) set({ status: "loading" });
    });
    media.addEventListener("timeupdate", () => {
      if (!isActive()) return;
      lastProgress = Date.now();
      if (pendingSeek > 0) return;
      listened(media);
      if (Math.abs(media.currentTime - get().position) >= 0.2) set({ position: media.currentTime });
      syncSystemMedia(); // throttled on the other side
    });
    media.addEventListener("progress", () => {
      if (!isActive() || !media.buffered.length) return;
      set({ buffered: media.buffered.end(media.buffered.length - 1) });
    });
    media.addEventListener("seeked", () => isActive() && syncPositionState());
    media.addEventListener("ended", () => isActive() && onEnded());
    media.addEventListener("error", () => isActive() && media.getAttribute("src") && onError(media));
  }
  wire(audio);
  for (const v of videos) wire(v);

  // A stream that stops arriving (the network gone, a server that stopped answering) doesn't always end in an
  // error: the player would wait forever, looking alive. No progress for a while is treated as one, so it's tried
  // again (from the phone itself when the server is out of reach).
  let checkedStall = 0;
  setInterval(() => {
    const media = activeMedia();
    const s = get();
    if (!media || s.remote || s.status !== "loading" || media.paused || !media.src) return;
    const stuck = Date.now() - lastProgress;
    if (link?.online && stuck >= STALL_CHECK_MS && checkedStall !== lastProgress) {
      const at = (checkedStall = lastProgress);
      void link.check().then((ok) => {
        if (ok || lastProgress !== at || activeMedia() !== media || get().status !== "loading") return;
        lastProgress = Date.now();
        onError(media);
      });
    }
    if (stuck < STALL_MS) return;
    lastProgress = Date.now();
    onError(media);
  }, 2000);

  const reloadIfKindChanged = () => {
    const s = get();
    const track = s.queue[s.index];
    if (!track) return;
    set({ videoNote: noteFor(track) });
    if (!loaded || loaded.id !== track.id) return;
    const wasPlaying = s.status === "playing" || s.status === "loading";
    if (needsClipLookup(track, s.preferVideo)) return load(s.index, { startAt: s.position, autoplay: wasPlaying });
    const kind = kindFor(track);
    if (loaded.kind === kind && kind === "audio") return;
    // Only the quality changed: the video plays on until the new one takes over (no going back to SD meanwhile).
    if (loaded.kind === kind && kind === "video" && videoEl.getAttribute("src")) return changeQuality();
    load(s.index, { startAt: s.position, autoplay: wasPlaying });
  };

  return {
    queue: saved.queue ?? [],
    original: saved.original ?? null,
    index: saved.index ?? 0,
    status: saved.queue?.length ? "paused" : "idle",
    remote: null,
    statusText: null,
    blocked: false,
    mediaKind: "audio",
    videoNote: null,
    videoAspect: 16 / 9,
    position: saved.position ?? 0,
    duration: saved.queue?.[saved.index ?? 0]?.duration ?? 0,
    buffered: 0,
    volume: saved.volume ?? 0.9,
    muted: saved.muted ?? false,
    shuffle: saved.shuffle ?? false,
    repeat: saved.repeat ?? "off",
    // Builds without video (Android) always play audio, whatever a backup or an old session says.
    preferVideo: capabilities.video && (saved.preferVideo ?? false),
    quality: toQuality(saved.quality),
    sleep: null,
    evenVolume: saved.evenVolume ?? true,
    videoQuality: SD,
    autoRadio: saved.autoRadio ?? true,

    playList: (tracks, start = 0) => {
      if (!tracks.length) return;
      const r = elsewhere();
      if (r) return r.playList(tracks, start);
      const first = tracks[start] ?? tracks[0];
      if (get().shuffle) {
        const rest = tracks.filter((_, i) => i !== start);
        set({ queue: [first, ...shuffled(rest)], original: tracks.slice() });
        load(0);
      } else {
        set({ queue: tracks.slice(), original: null });
        load(start);
      }
    },

    playTrack: (track) => {
      const r = elsewhere();
      if (r) return r.playTrack(track);
      const s = get();
      const at = s.queue.findIndex((t) => t.id === track.id);
      if (at >= 0) return load(at);
      if (!s.queue.length) return get().playList([track]);
      const insert = s.index + 1;
      set({
        queue: [...s.queue.slice(0, insert), track, ...s.queue.slice(insert)],
        original: s.original ? [...s.original, track] : null,
      });
      load(insert);
    },

    playNext: (track) => {
      const r = elsewhere();
      if (r) {
        r.playNext(track);
        return toast(getT().player.playsNext(track.title));
      }
      const s = get();
      if (!s.queue.length) return get().playList([track]);
      const insert = s.index + 1;
      set({
        queue: [...s.queue.slice(0, insert), track, ...s.queue.slice(insert)],
        original: s.original ? [...s.original, track] : null,
      });
      toast(getT().player.playsNext(track.title));
    },

    addToQueue: (track) => {
      const r = elsewhere();
      if (r) {
        r.addToQueue(track);
        return toast(getT().player.addedToQueue(track.title));
      }
      const s = get();
      if (!s.queue.length) return get().playList([track]);
      set({ queue: [...s.queue, track], original: s.original ? [...s.original, track] : null });
      toast(getT().player.addedToQueue(track.title));
    },

    reorderUpcoming: (tracks) => {
      if (elsewhere()) return;
      const s = get();
      const next = s.queue[s.index + 1];
      set({ queue: [...s.queue.slice(0, s.index + 1), ...tracks] });
      if (tracks[0] !== next) warmUpcoming();
    },

    moveInQueue: (from, to) => {
      const r = elsewhere();
      if (r) return r.moveTo(from, to);
      const s = get();
      if (from <= s.index || from >= s.queue.length) return;
      const at = Math.min(Math.max(to, s.index + 1), s.queue.length - 1);
      if (at === from) return;
      const upcoming = s.queue.slice(s.index + 1);
      const [track] = upcoming.splice(from - s.index - 1, 1);
      upcoming.splice(at - s.index - 1, 0, track!);
      get().reorderUpcoming(upcoming);
    },

    removeAt: (i) => {
      const r = elsewhere();
      if (r) return r.removeAt(i);
      const s = get();
      if (i < 0 || i >= s.queue.length) return;
      const removed = s.queue[i];
      const queue = s.queue.filter((_, j) => j !== i);
      const original = s.original?.filter((t) => t !== removed) ?? null;
      if (i < s.index) return set({ queue, original, index: s.index - 1 });
      if (i > s.index) return set({ queue, original });
      // Removing the current track: move on to whatever takes its place.
      set({ queue, original });
      if (queue[i]) load(i, { autoplay: s.status === "playing" });
      else {
        activeMedia()?.pause();
        loaded = null;
        set({ index: Math.max(0, queue.length - 1), status: queue.length ? "paused" : "idle", position: 0 });
      }
    },

    jumpTo: (i) => {
      const r = elsewhere();
      if (r) return r.jumpTo(i);
      load(i);
    },

    clearUpcoming: () => {
      const r = elsewhere();
      if (r) return r.clearUpcoming();
      const s = get();
      const keep = s.queue.slice(0, s.index + 1);
      set({ queue: keep, original: s.original ? keep.slice() : null });
    },

    startRadio: async (track) => {
      toast(getT().player.startingRadio(track.title));
      const r = elsewhere();
      if (r) return r.startRadio(track);
      try {
        const related = (await api.radio(track.id)).filter((t) => t.id !== track.id);
        const s = get();
        const current = s.queue[s.index];
        // The radio playlist: the tracks as queued, in the radio's order (made here, by the device that plays the
        // radio, so it holds just what this queue holds; the other devices get it with the library).
        const seed = current?.id === track.id ? current : track;
        void useLibrary.getState().makeRadioPlaylist(seed, [seed, ...related]);
        // Radio from the track that is on: it keeps going, uninterrupted, and the radio follows it.
        if (current?.id === track.id && s.status !== "idle" && s.status !== "error") {
          set({
            queue: [current, ...(s.shuffle ? shuffled(related) : related)],
            original: s.shuffle ? [current, ...related] : null,
            index: 0,
          });
          warmUpcoming();
          return;
        }
        get().playList([track, ...related], 0);
      } catch (e) {
        toast((e as Error).message, "error");
      }
    },

    toggle: () => {
      const r = elsewhere();
      if (r) return get().remote!.playing ? r.pause() : r.play();
      const s = get();
      const track = s.queue[s.index];
      if (!track) return;
      // The spinner is a stop button: a track stuck loading (YouTube holding it back) can be let go.
      if (s.status === "loading") return get().pause();
      const kind = kindFor(track);
      // Not the quality: SD plays while the chosen one downloads, and a video may only go up to a lower one. A quality
      // change takes over by itself (changeQuality); Play and Pause just play and pause.
      const stale = !loaded || loaded.id !== track.id || loaded.kind !== kind || needsClipLookup(track, s.preferVideo);
      if (stale || s.status === "error") return load(s.index, { startAt: s.position });
      const media = mediaFor(kind);
      if (media.paused) play(media);
      else media.pause();
    },

    unblock: () => {
      set({ blocked: false });
      const s = get();
      const media = loaded ? mediaFor(loaded.kind) : null;
      if (media?.getAttribute("src")) play(media);
      else load(s.index, { startAt: s.position });
    },

    pause: () => {
      if (get().blocked) set({ blocked: false });
      const s = get();
      if (s.status !== "playing" && s.status !== "loading") return;
      if (s.status === "loading") {
        // Whatever is on its way (a stream, a music video lookup, more radio) must not start playing when it arrives.
        const started = recordedToken === token;
        token++;
        // Buffering mid-track: already counted as a play, resuming mustn't count it again. Still starting: the next
        // Play loads the track again, from here.
        if (started) recordedToken = token;
        else {
          loaded = null;
          // Drop the request too, so the server stops waiting on YouTube for it.
          cancelSwap();
          for (const media of [audio, ...videos]) {
            media.removeAttribute("src");
            media.load();
          }
        }
      }
      audio.pause();
      videoEl.pause();
      set({ status: "paused", statusText: null });
      syncPlaybackState();
    },

    next: () => {
      const r = elsewhere();
      if (r) return r.next();
      const s = get();
      if (s.index < s.queue.length - 1) return skipTo(s.index + 1);
      if (s.repeat === "all" && s.queue.length) return skipTo(0);
      if (s.autoRadio) void continueWithRadio();
    },

    prev: () => {
      const r = elsewhere();
      if (r) return r.prev();
      const s = get();
      if (s.position > 3 || s.index === 0) return get().seek(0);
      skipTo(s.index - 1);
    },

    seek: (seconds) => {
      const r = elsewhere();
      if (r) {
        const remote = get().remote!;
        const at = Math.max(0, Math.min(seconds, remote.duration || seconds));
        set({ remote: { ...remote, position: at } });
        return r.seek(at);
      }
      const t = Math.max(0, Math.min(seconds, get().duration || seconds));
      set({ position: t });
      const media = activeMedia();
      const track = get().queue[get().index];
      if (!media || !track || loaded?.id !== track.id || media.readyState === 0) {
        pendingSeek = t;
        return;
      }
      media.currentTime = t;
    },

    setVolume: (v) => {
      const r = elsewhere();
      if (r) return r.setVolume(Math.max(0, Math.min(1, v)));
      const volume = Math.max(0, Math.min(1, v));
      const muted = volume === 0 ? true : false;
      audio.muted = videoEl.muted = muted;
      set({ volume, muted });
      applyVolume();
    },

    toggleMute: () => {
      const r = elsewhere();
      if (r) return r.toggleMute();
      const muted = !get().muted;
      audio.muted = videoEl.muted = muted;
      if (!muted && get().volume === 0) get().setVolume(0.6);
      else set({ muted });
    },

    toggleShuffle: () => {
      const r = elsewhere();
      if (r) return r.toggleShuffle();
      const s = get();
      const current = s.queue[s.index];
      if (!s.shuffle) {
        const rest = s.queue.filter((_, i) => i !== s.index);
        set({ shuffle: true, original: s.queue, queue: current ? [current, ...shuffled(rest)] : shuffled(rest), index: 0 });
        return;
      }
      const present = new Set(s.queue);
      const base = (s.original ?? s.queue).filter((t) => present.has(t));
      const extra = s.queue.filter((t) => !base.includes(t));
      const queue = [...base, ...extra];
      set({ shuffle: false, original: null, queue, index: Math.max(0, current ? queue.indexOf(current) : 0) });
    },

    cycleRepeat: () => {
      const r = elsewhere();
      if (r) return r.cycleRepeat();
      const order: Repeat[] = ["off", "all", "one"];
      set({ repeat: order[(order.indexOf(get().repeat) + 1) % order.length] });
    },

    setPreferVideo: (on) => {
      const r = elsewhere();
      if (r) return r.setPreferVideo(on);
      if (on && !capabilities.video) return;
      set({ preferVideo: on });
      reloadIfKindChanged();
    },

    setQuality: (quality) => {
      const r = elsewhere();
      if (r) return r.setQuality(quality);
      set({ quality });
      reloadIfKindChanged();
    },

    setAutoRadio: (autoRadio) => {
      const r = elsewhere();
      if (r) return r.setAutoRadio(autoRadio);
      set({ autoRadio });
    },

    setEvenVolume: (evenVolume) => {
      set({ evenVolume });
      const id = loaded?.media;
      if (evenVolume && id && loaded?.kind === "audio") learnGain(id);
      applyVolume();
    },

    setSleep: (minutes) => {
      clearTimeout(sleepTimer);
      if (minutes === null) return set({ sleep: null });
      if (minutes === "track") {
        set({ sleep: "track" });
        // Another device playing: its track's end isn't heard here, so it's the time left in it.
        const r = get().remote;
        if (r) sleepTimer = setTimeout(asleep, Math.max(0, (r.duration - r.position) * 1000));
        return;
      }
      const at = Date.now() + minutes * 60_000;
      set({ sleep: at });
      sleepTimer = setTimeout(asleep, minutes * 60_000);
    },

    takeOver: (queue, index, position, shuffle, repeat) => {
      if (!queue.length) return;
      const at = Math.min(Math.max(index, 0), queue.length - 1);
      // The order comes as the other device had it (shuffled or not); turning shuffle off here keeps it.
      set({ queue: queue.slice(), original: null, shuffle, repeat });
      load(at, { startAt: position });
    },
  };
});

// How tall the video shows on screen (the picture inside the element, which keeps its proportions), once a resize has
// settled: an animation passing through a big size doesn't count. Auto picks the quality from it (see fetchedFor).
if (typeof ResizeObserver !== "undefined") {
  let settle: ReturnType<typeof setTimeout> | undefined;
  new ResizeObserver(() => {
    clearTimeout(settle);
    settle = setTimeout(() => {
      const w = videoBox.clientWidth;
      const h = videoBox.clientHeight;
      const ratio = videoEl.videoWidth && videoEl.videoHeight ? videoEl.videoWidth / videoEl.videoHeight : 16 / 9;
      // The picture's shorter side: what YouTube's quality lines measure (a vertical 1080p clip is 1080 wide).
      const picture = w / h > ratio ? [h * ratio, h] : [w, w / ratio];
      onShown(Math.round(Math.min(picture[0], picture[1])));
    }, 800);
  }).observe(videoBox);
}

audio.volume = videoEl.volume = usePlayer.getState().volume;
audio.muted = videoEl.muted = usePlayer.getState().muted;
standbyVideo().muted = true;

export const selectCurrent = (s: PlayerState): Track | null => s.queue[s.index] ?? null;

// What the player shows: this device's playback, or the one of the device it controls (`remote`).
export const selectShown = (s: PlayerState): Track | null => (s.remote ? s.remote.track : selectCurrent(s));
export const selectShownStatus = (s: PlayerState): Status => (s.remote ? (s.remote.playing ? "playing" : "paused") : s.status);
export const selectShownPosition = (s: PlayerState) => (s.remote ? s.remote.position : s.position);
export const selectShownDuration = (s: PlayerState) => (s.remote ? s.remote.duration : s.duration);
export const selectHasShown = (s: PlayerState) => (s.remote ? !!s.remote.track : s.queue.length > 0);
export const selectShownQueue = (s: PlayerState) => (s.remote ? s.remote.queue : s.queue);
export const selectShownIndex = (s: PlayerState) => (s.remote ? s.remote.index : s.index);

/** Whether the track can be shown as video (art tracks are audio with a still image). */

// Persistence: resume the same queue and position after a reload.

function persist() {
  const s = usePlayer.getState();
  const data: Saved = {
    queue: s.queue.slice(0, 500),
    original: s.original?.slice(0, 500) ?? null,
    index: s.index,
    position: s.position,
    volume: s.volume,
    muted: s.muted,
    shuffle: s.shuffle,
    repeat: s.repeat,
    preferVideo: s.preferVideo,
    quality: s.quality,
    autoRadio: s.autoRadio,
    evenVolume: s.evenVolume,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* storage full or blocked */
  }
}
setInterval(persist, 4000);
addEventListener("pagehide", persist);
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && persist());

// Media Session: lock-screen, headset and notification controls.

function setMetadata(track: Track) {
  systemMedia?.setTrack({
    title: track.title,
    artist: track.artist,
    album: track.album ?? "",
    artwork: track.art || track.thumb,
    duration: track.duration || undefined,
  });
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album ?? "",
    artwork:
      track.kind === "video"
        ? [
            { src: track.art, sizes: "1280x720", type: "image/jpeg" },
            { src: track.thumb, sizes: "320x180", type: "image/jpeg" },
          ]
        : [{ src: track.art, sizes: "544x544", type: "image/jpeg" }],
  });
}

/** The phone's notification and lock screen. A track that is loading is about to play, so it counts as playing:
 *  reporting a pause between tracks would let Android stop the app in the background. */
function syncSystemMedia() {
  if (!systemMedia) return;
  const { status, position, duration } = usePlayer.getState();
  systemMedia.setState({ playing: status === "playing" || status === "loading", position, duration });
}

function syncPlaybackState() {
  syncSystemMedia();
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.playbackState = usePlayer.getState().status === "playing" ? "playing" : "paused";
  syncPositionState();
}

function syncPositionState() {
  syncSystemMedia();
  const { duration, position } = usePlayer.getState();
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!Number.isFinite(duration) || duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({ duration, position: Math.min(position, duration), playbackRate: 1 });
  } catch {
    /* some browsers reject transient states */
  }
}

if (systemMedia) {
  const p = () => usePlayer.getState();
  // The notification, the lock screen and headphone or car buttons show and drive this device's own player, even
  // while it controls another device.
  systemMedia.onAction((action, position) =>
    locally(() => {
      if (action === "play" && p().status !== "playing") p().toggle();
      else if (action === "pause" && p().status === "playing") p().toggle();
      else if (action === "next") p().next();
      else if (action === "previous") p().prev();
      else if (action === "seek" && position != null) p().seek(position);
    }),
  );
}

if ("mediaSession" in navigator) {
  const ms = navigator.mediaSession;
  const p = () => usePlayer.getState();
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ["play", () => p().status !== "playing" && p().toggle()],
    ["pause", () => p().status === "playing" && p().toggle()],
    ["previoustrack", () => p().prev()],
    ["nexttrack", () => p().next()],
    ["seekto", (d) => d.seekTime != null && p().seek(d.seekTime)],
    ["seekbackward", (d) => p().seek(p().position - (d.seekOffset ?? 10))],
    ["seekforward", (d) => p().seek(p().position + (d.seekOffset ?? 10))],
  ];
  for (const [action, handler] of handlers) {
    try {
      // Media keys and the browser's controls show this device's player: they drive it, not a device it controls.
      ms.setActionHandler(action, (d) => locally(() => handler(d)));
    } catch {
      /* action not supported */
    }
  }
  const restored = selectCurrent(usePlayer.getState());
  if (restored) setMetadata(restored);
}

if (desktop?.platform === "win32" && desktop.updateMediaControls) {
  let lastState = "";
  const syncThumbar = () => {
    const player = usePlayer.getState();
    // What plays: this computer's, or the device it controls (Devices).
    const track = selectShown(player);
    const status = selectShownStatus(player);
    const favorite = !!track && useLibrary.getState().isFavorite(track.id);
    const playing = status === "playing" || status === "loading";
    const t = getT();
    const state = {
      hasTrack: !!track,
      playing,
      favorite,
      labels: {
        favorite: favorite ? t.common.removeFromFavorites : t.common.addToFavorites,
        previous: t.player.previous,
        play: playing ? t.common.pause : t.common.play,
        next: t.player.next,
      },
    };
    const serialized = JSON.stringify(state);
    if (serialized !== lastState) {
      lastState = serialized;
      desktop?.updateMediaControls?.(state);
    }
  };
  usePlayer.subscribe(syncThumbar);
  useLibrary.subscribe(syncThumbar);
  desktop.onMediaAction?.((action) => {
    const player = usePlayer.getState();
    const track = selectShown(player);
    if (action === "favorite" && track) void useLibrary.getState().toggleFavorite(track);
    else if (action === "toggle") player.toggle();
    else if (action === "next") player.next();
    else if (action === "previous") player.prev();
  });
  syncThumbar();
}

/** The player's status line in the current language, or null when there is nothing to say. */
export function useStatusText(): string | null {
  // This device's loading notes and errors don't describe the device it controls.
  const note = usePlayer((s) => (s.remote ? null : s.statusText));
  const t = useT();
  if (note === null) return null;
  return typeof note === "string" ? t.player.status[note] : note.error;
}
