import { App } from "@capacitor/app";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import {
  album as albumPage,
  ALBUM_ID,
  artist as artistPage,
  ARTIST_ID,
  GENRE_ID,
  genre as genrePage,
  genreArtists,
  genres,
  home,
  moods,
  weeklyMix,
  searchAlbums,
  searchArtists,
  searchPlaylists,
  ytPlaylist as ytPlaylistPage,
  YT_PLAYLIST_ID,
} from "../../../server/src/browse";
import { msg, tr, type MsgKey } from "../../../server/src/i18n";
import * as library from "../../../server/src/library";
import { lyricsFor } from "../../../server/src/lyrics";
import { discover } from "../../../server/src/profile";
import { findVideoFor, radio, search, suggestions } from "../../../server/src/search";
import { HttpError, VIDEO_ID } from "../../../server/src/types";
import { getLang, getT } from "../i18n";
import { ApiError, type CarSettings, type Connection, type MusikeApi, type ServerLink, type SystemInfo } from "../lib/apiTypes";
import { androidFullscreen } from "./android";
import { makeConnection, savedConnection, serverBackend } from "./connection";
import { media, Playback } from "./media";
import { offlineCapable } from "./offline";
import { nativeStorage } from "./storage";
import { forgetUrl, resolveAudio } from "./streams";

// The Android backend: the Musike server's own code (search, genres, artists, albums, library), running on the
// phone instead of behind HTTP. The build swaps lib/api.ts for this module (see vite.config.ts).
// Connected to a Musike server instead (Settings > Server), every request goes to that server (connection.ts).
export * from "../lib/apiTypes";

const saved = savedConnection();
const server = saved.mode === "server" ? serverBackend(saved.url) : null;

// On the phone the library is one JSON document in the app's storage.
const lib = library.jsonLibrary(nativeStorage);

const fail = (status: number, key: MsgKey) => new ApiError(status, tr(getLang(), msg(key)));

/** Runs a server function and turns its errors into what the app expects, in the app's language. */
async function call<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  try {
    const result = await fn();
    // The work can't be cancelled midway, but a caller that gave up must not get the result.
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return result;
  } catch (e) {
    if (e instanceof HttpError) throw new ApiError(e.status, tr(getLang(), e.text), e.code);
    if (e instanceof ApiError || (e as Error).name === "AbortError") throw e;
    throw new ApiError(500, (e as Error).message || getT().player.serverDown);
  }
}

const tracks = (list: unknown[]) => list.slice(0, 500).map(library.sanitizeTrack);

async function noAccounts(): Promise<never> {
  throw new ApiError(400, tr(getLang(), msg("accountsOff")));
}

const SYSTEM: SystemInfo = {
  ytdlp: { path: "built-in", version: null, channel: "stable", latest: { stable: null, nightly: null }, updateAvailable: false },
  deno: "built-in",
  ffmpeg: null,
  canInstall: false,
  job: null,
};

const PROFILE_IMAGE = "musike:profile-image";
const ACCOUNT_SETTINGS = "musike:account-settings";

/** The phone's own engine (YouTube, from the phone) over a library: the phone's own, or the copy of a server account's. */
function phoneApi(lib: library.LibraryStore): MusikeApi {
  return {
  search: (q, type, signal) =>
    call(async () => {
      if (!q.trim()) throw fail(400, "emptyQuery");
      return search(q.trim().slice(0, 200), type, getLang());
    }, signal),
  suggest: (q, signal) => call(() => suggestions(q.trim().slice(0, 100), getLang()).catch(() => []), signal),
  radio: (id) => call(() => radio(id)),
  genres: () => call(() => genres(getLang())),
  moods: () => call(() => moods(getLang())),
  home: (signal) => call(() => home(getLang()), signal),
  weeklyMix: (signal) =>
    call(async () => {
      const [l, top] = await Promise.all([lib.getLibraryLite(), lib.topPlays(Date.now() - 28 * 24 * 3600_000, 30)]);
      return weeklyMix("phone", { favorites: l.favorites, history: l.history, top: top.map((p) => p.track) }, getLang()).catch(() => null);
    }, signal),
  genre: (id, signal) =>
    call(async () => {
      if (!GENRE_ID.test(id)) throw fail(400, "invalidGenre");
      return genrePage(id, getLang());
    }, signal),
  genreArtists: (id, offset) => call(() => genreArtists(id, offset, getLang())),
  artist: (id, signal) =>
    call(async () => {
      if (!ARTIST_ID.test(id)) throw fail(400, "invalidArtist");
      return artistPage(id, getLang());
    }, signal),
  album: (id, signal) =>
    call(async () => {
      if (!ALBUM_ID.test(id)) throw fail(400, "invalidAlbum");
      return albumPage(id, getLang());
    }, signal),
  searchAlbums: (q, signal) => call(() => searchAlbums(q.trim().slice(0, 200), getLang()), signal),
  searchArtists: (q, signal) => call(() => searchArtists(q.trim().slice(0, 200), getLang()), signal),
  searchPlaylists: (q, signal) => call(() => searchPlaylists(q.trim().slice(0, 200), getLang()), signal),
  ytPlaylist: (id, signal) =>
    call(async () => {
      if (!YT_PLAYLIST_ID.test(id)) throw fail(400, "invalidYtPlaylist");
      return ytPlaylistPage(id, getLang());
    }, signal),
  videoFor: (t) => call(() => findVideoFor(t.id, t.title, t.artist, t.duration)),
  lyrics: (t, signal) =>
    call(() => lyricsFor({ id: t.id, title: t.title, artist: t.artist, album: t.album, duration: t.duration }), signal),
  prepare: (id, signal) =>
    call(async () => {
      if (!VIDEO_ID.test(id)) throw fail(400, "invalidVideoId");
      const r = await resolveAudio(id);
      return { id, title: r.title, duration: r.duration, hasSdVideo: false };
    }, signal),
  loudness: (id) => call(async () => (VIDEO_ID.test(id) ? ((await resolveAudio(id)).loudnessDb ?? null) : null)),
  // Video needs a server: the phone on its own never asks.
  videoQualities: () => Promise.reject(fail(404, "noSdVideo")),
  prepareVideo: () => Promise.reject(fail(404, "noSdVideo")),
  // The phone keeps no files: the stream is resolved ahead, so it starts without that wait.
  prefetchAudio: (id) =>
    call(async () => {
      if (VIDEO_ID.test(id)) await resolveAudio(id);
    }),

  library: () => call(() => lib.getLibraryLite()),
  addFavorite: (t) => call(async () => ({ favorites: await lib.addFavorite(library.sanitizeTrack(t)) })),
  addFavorites: (list) => call(async () => ({ favorites: await lib.addFavorites(tracks(list)) })),
  removeFavorite: (id) => call(async () => ({ favorites: await lib.removeFavorite(id) })),
  pushHistory: (t, at) => call(async () => ({ history: await lib.pushHistory(library.sanitizeTrack(t), at) })),
  plays: (artistId, name, signal) =>
    call(async () => {
      if (artistId === undefined) return lib.allPlays();
      if (!ARTIST_ID.test(artistId)) throw fail(400, "invalidArtist");
      return lib.playsFor(artistId, (name ?? "").slice(0, 300));
    }, signal),
  topPlays: (range, limit = 5, signal) =>
    call(async () => {
      const since = typeof range === "object" ? range.since : range === "all" ? 0 : Date.now() - 91 * 24 * 3600_000;
      return { plays: await lib.topPlays(since, Math.min(Math.max(limit, 1), 100)), first: await lib.firstPlay() };
    }, signal),
  playLog: (since, until, signal) =>
    call(async () => {
      const log = await lib.playLog(since, until);
      const at = new Map(log.tracks.map((t, i) => [t.id, i]));
      return {
        tracks: log.tracks,
        rows: log.rows.flatMap(([id, when, n, restored]): [number, number, number, number][] =>
          at.has(id) ? [[at.get(id)!, when, n, restored]] : [],
        ),
        first: await lib.firstPlay(),
        dated: log.dated,
      };
    }, signal),
  // On the phone on its own: kept in the app's storage, like the rest of its settings.
  profileSettings: async () => {
    try {
      const v = JSON.parse(localStorage.getItem(ACCOUNT_SETTINGS) ?? "{}") as { accent?: string; profilePeriod?: string };
      return { accent: v.accent ?? null, profilePeriod: v.profilePeriod ?? null };
    } catch {
      return { accent: null, profilePeriod: null };
    }
  },
  setProfileSettings: async (patch) => {
    let v: { accent: string | null; profilePeriod: string | null } = { accent: null, profilePeriod: null };
    try {
      v = { ...v, ...(JSON.parse(localStorage.getItem(ACCOUNT_SETTINGS) ?? "{}") as object), ...patch };
      localStorage.setItem(ACCOUNT_SETTINGS, JSON.stringify(v));
    } catch {
      /* this session only */
    }
    return v;
  },
  // On the phone: kept in the app's storage.
  profileImage: async () => {
    try {
      return localStorage.getItem(PROFILE_IMAGE);
    } catch {
      return null;
    }
  },
  setProfileImage: async (image) => {
    try {
      if (image) localStorage.setItem(PROFILE_IMAGE, image);
      else localStorage.removeItem(PROFILE_IMAGE);
    } catch {
      throw new ApiError(0, getT().profile.imageTooBig);
    }
    return image;
  },
  removeFromHistory: (id) => call(async () => ({ history: await lib.removeFromHistory(id) })),
  forget: (id) => call(async () => ({ history: await lib.forget(id) })),
  // On the phone: the artists' pages from YouTube, from here.
  discover: (signal) =>
    call(async () => discover(await lib.allPlays(), (await lib.getLibraryLite()).artists, (id) => artistPage(id, getLang())), signal),
  saveArtist: (a) => call(async () => ({ artists: await lib.saveArtist(library.sanitizeArtist(a)) })),
  removeArtist: (id) => call(async () => ({ artists: await lib.removeArtist(id) })),
  saveAlbum: (a) => call(async () => ({ albums: await lib.saveAlbum(library.sanitizeAlbum(a)) })),
  removeAlbum: (id) => call(async () => ({ albums: await lib.removeAlbum(id) })),
  saveYtPlaylist: (p) => call(async () => ({ ytPlaylists: await lib.saveYtPlaylist(library.sanitizeYtPlaylist(p)) })),
  removeYtPlaylist: (id) => call(async () => ({ ytPlaylists: await lib.removeYtPlaylist(id) })),
  createPlaylist: (name, list = []) => call(() => lib.createPlaylist(name, tracks(list))),
  renamePlaylist: (id, name) => call(() => lib.renamePlaylist(id, name)),
  deletePlaylist: (id) => call(() => lib.deletePlaylist(id)),
  addToPlaylist: (id, t) => call(() => lib.addToPlaylist(id, Array.isArray(t) ? tracks(t) : library.sanitizeTrack(t))),
  removeFromPlaylist: (id, trackId) => call(() => lib.removeFromPlaylist(id, trackId)),
  reorderPlaylist: (id, ids) => call(() => lib.reorderPlaylist(id, ids)),
  createRadioPlaylist: (name, seed, list) => call(() => lib.createRadioPlaylist(name, seed, tracks(list))),
  updateRadioPlaylist: (id, patch) => call(() => lib.updateRadioPlaylist(id, library.sanitizeRadioPatch(patch))),
  saveRadioPlaylist: (id) => call(() => lib.saveRadioPlaylist(id)),
  recent: (signal) => call(() => lib.recent(), signal),
  pushRecent: (item) => call(async () => lib.pushRecent(library.sanitizeRecent(item))),
  removeRecent: (kind, id) => call(() => lib.removeRecent(kind, id)),
  clearRecent: () => call(() => lib.clearRecent()),
  importLibrary: (backup, mode) =>
    call(async () => {
      const b = (backup ?? {}) as { format?: unknown; version?: unknown; library?: unknown };
      if (b.format !== "musike-backup") throw fail(400, "notBackup");
      if (typeof b.version !== "number" || b.version > 1) throw fail(400, "newerBackup");
      return lib.importLibrary(b.library, mode);
    }),

  system: async () => SYSTEM,
  updateYtdlp: async () => {
    throw new ApiError(400, "yt-dlp isn't used on this device.");
  },

  // Accounts are a server thing: the phone's own library has none.
  authStatus: async () => ({ enabled: false, setup: false, user: null }),
  setup: noAccounts,
  login: noAccounts,
  logout: noAccounts,
  changePassword: noAccounts,
  users: noAccounts,
  createUser: noAccounts,
  setUserRole: noAccounts,
  resetUserPassword: noAccounts,
  deleteUser: noAccounts,
  };
}

const onThePhone = phoneApi(lib);

/** Connected to a server: the server, or the phone with the account's copy while the server is out of reach. */
const offline = server ? offlineCapable({ url: saved.url, server: server.api, phone: phoneApi }) : null;

export const api: MusikeApi = offline ? offline.api : onThePhone;

/** Whether the server answers (connected to one), for Settings and to reload when it's back. */
export const link: ServerLink | null = offline?.link ?? null;

// YouTube's own words for its bot check, from any client; the player then stops instead of skipping (see botCheck).
const BOT_CHECK = /confirm you.?re not a bot|sign in to confirm/i;
const phoneStream = (id: string) =>
  resolveAudio(id).then(
    (r) => r.url,
    (e: Error) => {
      throw BOT_CHECK.test(e.message) ? new ApiError(503, tr(getLang(), msg("botCheck")), "bot_check") : e;
    },
  );

/**
 * On the phone, the media element plays YouTube's stream directly: resolved here, no proxy needed. Connected to a
 * server, it plays the server's stream proxy; with the server out of reach, the phone's again (audio only).
 */
export const streamSource = (id: string, kind: "audio" | "video" = "audio", height = 360): Promise<string> =>
  server && offline
    ? offline.streamSource(id, () => server.streamUrl(id, kind, height), () => phoneStream(id))
    : phoneStream(id);

export async function explainStreamError(url: string, error?: MediaError | null): Promise<{ message: string }> {
  // The server's stream: the server says why, if it's still there.
  if (server && offline && (url.startsWith(saved.url) || url.includes("_capacitor_http_interceptor_"))) {
    if (!(await offline.check())) return { message: getT().offline.gone };
    return server.explain(url, error);
  }
  forgetUrl(url);
  return { message: navigator.onLine ? getT().player.streamFailed : getT().player.offline };
}

/** Where the library and the music come from: this phone, or a Musike server (Settings > Server). */
export const connection: Connection = makeConnection(saved, api, () => lib.getLibrary());

/** A picture (the listening report) through Android's share sheet: written to the app's cache, then shared. */
export async function shareImage(blob: Blob, name: string, title: string): Promise<"shared" | "saved" | "cancelled"> {
  const data = await new Promise<string>((done, fail) => {
    const reader = new FileReader();
    reader.onload = () => done(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => fail(reader.error);
    reader.readAsDataURL(blob);
  });
  const { uri } = await Filesystem.writeFile({ path: name, data, directory: Directory.Cache });
  try {
    await Share.share({ title, files: [uri], dialogTitle: title });
    return "shared";
  } catch {
    return "cancelled";
  }
}

/** Links go out through Android's share sheet (WhatsApp, Telegram, copy...). */
export async function shareLink(title: string, url: string): Promise<"shared" | "copied" | "cancelled"> {
  try {
    await Share.share({ title, text: title, url, dialogTitle: title });
    return "shared";
  } catch {
    return "cancelled";
  }
}

/** Backups are shared through Android's share sheet (save to Files, Drive, send to the computer…). */
export async function saveFile(name: string, text: string) {
  const { uri } = await Filesystem.writeFile({ path: name, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
  await Share.share({ title: name, files: [uri] });
}

export const systemMedia = media;

/**
 * On the phone alone there's no video (videos play as audio). Connected to a server, the server streams the video
 * too, as in the browser, while it answers: out of reach, the phone plays on its own, audio only, so the video
 * options go away instead of showing a blank video.
 */
export const capabilities = {
  get video() {
    return !!offline && offline.online();
  },
  engineSettings: false,
  retryOnError: true,
  playLog: !!server,
};

/** Android Auto's lists and searches (native/car.ts), loaded only in the app. */
export const startCar: (() => void) | null = () => void import("./car").then((m) => m.startCar());

/**
 * YouTube links opened with Musike, or shared to it (MainActivity turns a share into the same link). The App plugin
 * keeps the one the app was started with until this listener asks for it.
 */
export const openedLinks: ((open: (url: string) => void) => () => void) | null = (open) => {
  const sub = App.addListener("appUrlOpen", ({ url }) => open(url));
  return () => void sub.then((s) => s.remove());
};

/** Settings > Android Auto: opening the app from the car, and the car's log. */
export const car: CarSettings | null = {
  info: () => Playback.carInfo(),
  openBackgroundSettings: () => Playback.openBackgroundSettings(),
  shareLog: async (text) => {
    await Share.share({ title: "Musike Android Auto", text, dialogTitle: "Musike Android Auto" }).catch(() => {});
  },
};

/** The cinema view's full screen: the app hides the system bars and turns the screen itself (native/android.ts). */
export const appFullscreen: ((on: boolean, landscape: boolean) => Promise<void>) | null = androidFullscreen;

/** Devices in step: only connected to a Musike server over https (see native/connection.ts). */
export const syncAddress: (() => Promise<string>) | null = server?.syncAddress ?? null;
