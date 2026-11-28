import { msg } from "./i18n.js";
import {
  ALBUM_ID,
  ARTIST_ID,
  HttpError,
  VIDEO_ID,
  type Library,
  type PlayEntry,
  type Playlist,
  type RadioInfo,
  type RecentItem,
  type RecentKind,
  type SavedAlbum,
  type SavedArtist,
  type SavedYtPlaylist,
  type Track,
  YT_PLAYLIST_ID,
} from "./types.js";

// No Node-only imports here: the Android app runs this same module, with its own storage.

export const HISTORY_LIMIT = 60;
export const SAVED_LIMIT = 2000;
/** Tracks remembered in the play log of the JSON library; the least recently played go first. */
export const PLAYS_LIMIT = 3000;
/** Entries in the Search page's "Recent" list. */
export const RECENT_LIMIT = 50;
export const RECENT_KINDS: readonly RecentKind[] = ["query", "track", "artist", "album", "playlist"];

/**
 * Everything the app does with a library. Two implementations: jsonLibrary below (one JSON document, used by
 * the Android and desktop apps) and the SQLite one in librarySqlite.ts (the server). They behave the same.
 */
/** One row of the play log: track id, when (ms), how many plays, 1 when restored from a backup. */
export type PlayRow = [string, number, number, 0 | 1];

/** At most this many rows of the play log at once (years of listening). */
export const PLAY_LOG_LIMIT = 200_000;

/** Tracks put in the order of `ids`; the ones `ids` leaves out follow, in the order they had. */
export function inOrder<T extends { id: string }>(tracks: T[], ids: string[]): T[] {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const first = [...new Set(ids)].flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  const placed = new Set(first.map((t) => t.id));
  return [...first, ...tracks.filter((t) => !placed.has(t.id))];
}

export interface LibraryStore {
  getLibrary(): Promise<Library>;
  /** The library without the play log, which can be large and is fetched on its own (playsFor, allPlays). */
  getLibraryLite(): Promise<Omit<Library, "plays">>;
  /** The tracks of one artist played here, most played first (then most recent). */
  playsFor(artistId: string, name: string, limit?: number): Promise<PlayEntry[]>;
  /** The whole play log, most recently played first. */
  allPlays(): Promise<PlayEntry[]>;
  /**
   * The most played tracks since a time (ms; 0: ever), most played first. The JSON library keeps only totals: it
   * ranks the tracks played since then by all their plays.
   */
  topPlays(since: number, limit: number): Promise<PlayEntry[]>;
  /** When the first play still on record was made (ms), or null with none. */
  firstPlay(): Promise<number | null>;
  /**
   * Every play between two times, oldest first, for the statistics: [track id, when, how many, restored from a
   * backup (1: its date is only the last play's)]. The JSON library keeps only totals: one row per track,
   * dated: false.
   */
  playLog(since: number, until: number): Promise<{ rows: PlayRow[]; tracks: Track[]; dated: boolean }>;
  /** Off the Recently played list only. */
  removeFromHistory(id: string): Promise<Track[]>;
  /** Damnatio memoriae: every trace of the track's plays goes (history, play log, recent), as if never played. */
  forget(id: string): Promise<Track[]>;
  addFavorite(track: Track): Promise<Track[]>;
  /** Adds many at once (in the given order, on top), skipping ones already there. */
  addFavorites(tracks: Track[]): Promise<Track[]>;
  removeFavorite(id: string): Promise<Track[]>;
  /** Saving puts it on top (saving again moves it there), stamped now. */
  saveArtist(artist: SavedArtist): Promise<SavedArtist[]>;
  removeArtist(id: string): Promise<SavedArtist[]>;
  saveAlbum(album: SavedAlbum): Promise<SavedAlbum[]>;
  removeAlbum(id: string): Promise<SavedAlbum[]>;
  saveYtPlaylist(playlist: SavedYtPlaylist): Promise<SavedYtPlaylist[]>;
  removeYtPlaylist(id: string): Promise<SavedYtPlaylist[]>;
  /**
   * A track started: on top of the history, and one more play in the play log, at `at` when given (a play made
   * on a phone while the server was out of reach, sent later) or now.
   */
  pushHistory(track: Track, at?: unknown): Promise<Track[]>;
  createPlaylist(name: string, tracks?: Track[]): Promise<Playlist>;
  renamePlaylist(pid: string, name: string): Promise<Playlist>;
  deletePlaylist(pid: string): Promise<void>;
  addToPlaylist(pid: string, tracks: Track | Track[]): Promise<Playlist>;
  removeFromPlaylist(pid: string, trackId: string): Promise<Playlist>;
  /** The playlist's tracks in this order (ids); ones left out keep their order after them, unknown ids are ignored. */
  reorderPlaylist(pid: string, ids: string[]): Promise<Playlist>;
  /**
   * The radio playlist for a radio just started: `tracks` as queued, from `seed`. The radio playlist there was, not
   * saved, goes (the app asked first if it had been changed).
   */
  createRadioPlaylist(name: string, seed: string, tracks: Track[]): Promise<Playlist>;
  /** Kept tracks, or regenerated ones (with the ones taken out): only on a radio playlist, which is then changed. */
  updateRadioPlaylist(pid: string, patch: RadioPatch): Promise<Playlist>;
  /**
   * A radio playlist saved: only its kept tracks stay (in its order), the others go, and it is a playlist like the
   * others from now on. One with nothing kept can't be saved; one saved already is left as it is.
   */
  saveRadioPlaylist(pid: string): Promise<Playlist>;
  /**
   * "merge" adds what is missing and never deletes (playlists match by id, then by name).
   * "replace" swaps the whole library for the backup's.
   */
  importLibrary(input: unknown, mode: "merge" | "replace"): Promise<ImportResult>;
  /** The "Recent" list, newest first (not part of backups). */
  recent(): Promise<RecentItem[]>;
  /** On top of the list, stamped now (an entry already there moves). */
  pushRecent(item: RecentItem): Promise<RecentItem[]>;
  removeRecent(kind: string, id: string): Promise<RecentItem[]>;
  clearRecent(): Promise<RecentItem[]>;
}

/** Where the JSON library is kept: a file on the desktop app, app storage on Android. */
export interface LibraryStorage {
  read(): Promise<string | null>;
  write(json: string): Promise<void>;
}

export const randomUUID = () => globalThis.crypto.randomUUID();

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const url = (v: unknown) => {
  const s = str(v, 500);
  return /^https:\/\//.test(s) ? s : "";
};
const time = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : Date.now());

/** When a play was made, as a client says: in the last year and not in the future, otherwise now. */
/**
 * When a play happened, as the app says (ms), within the last year. A phone's clock a few minutes ahead of the
 * server's is taken as it is: the same play sent again later (it was queued, or its first answer was lost) must
 * keep the same time, to be recognized and counted once.
 */
export function playedAt(at: unknown, now = Date.now()): number {
  const n = typeof at === "string" && /^\d{1,16}$/.test(at) ? Number(at) : at;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) return now;
  return n > now + CLOCK_SKEW_MS || n < now - 366 * 24 * 3600_000 ? now : n;
}
const CLOCK_SKEW_MS = 10 * 60_000;

export function sanitizeTrack(input: unknown): Track {
  const t = (input ?? {}) as Record<string, unknown>;
  const id = str(t.id, 11);
  if (!VIDEO_ID.test(id)) throw new HttpError(400, msg("invalidTrack"));
  return {
    id,
    title: str(t.title, 300) || "Untitled",
    artist: str(t.artist, 300),
    album: str(t.album, 300) || undefined,
    artistId: ARTIST_ID.test(str(t.artistId, 30)) ? str(t.artistId, 30) : undefined,
    albumId: ALBUM_ID.test(str(t.albumId, 64)) ? str(t.albumId, 64) : undefined,
    duration: typeof t.duration === "number" && Number.isFinite(t.duration) ? Math.max(0, Math.round(t.duration)) : 0,
    thumb: url(t.thumb),
    art: url(t.art),
    kind: t.kind === "video" ? "video" : "song",
  };
}

export function sanitizeArtist(input: unknown): SavedArtist {
  const a = (input ?? {}) as Record<string, unknown>;
  const id = str(a.id, 30);
  if (!ARTIST_ID.test(id)) throw new HttpError(400, msg("invalidArtist"));
  return { id, name: str(a.name, 300) || "Artist", thumb: url(a.thumb), art: url(a.art), savedAt: time(a.savedAt) };
}

export function sanitizeAlbum(input: unknown): SavedAlbum {
  const a = (input ?? {}) as Record<string, unknown>;
  const id = str(a.id, 64);
  if (!ALBUM_ID.test(id)) throw new HttpError(400, msg("invalidAlbum"));
  const artistId = str(a.artistId, 30);
  return {
    id,
    title: str(a.title, 300) || "Album",
    artist: str(a.artist, 300),
    artistId: ARTIST_ID.test(artistId) ? artistId : undefined,
    year: str(a.year, 20),
    thumb: url(a.thumb),
    art: url(a.art),
    savedAt: time(a.savedAt),
  };
}

export function sanitizeYtPlaylist(input: unknown): SavedYtPlaylist {
  const p = (input ?? {}) as Record<string, unknown>;
  const id = str(p.id, 90);
  if (!YT_PLAYLIST_ID.test(id)) throw new HttpError(400, msg("invalidYtPlaylist"));
  return {
    id,
    title: str(p.title, 300) || "Playlist",
    author: str(p.author, 300),
    thumb: url(p.thumb),
    art: url(p.art),
    savedAt: time(p.savedAt),
  };
}

/** A "Recent" entry from the app, validated; its id comes from what it is (a search's id is its lowercase text). */
export function sanitizeRecent(input: unknown): RecentItem {
  const r = (input ?? {}) as Record<string, unknown>;
  const at = Date.now();
  switch (r.kind) {
    case "query": {
      const q = str(r.q, 200).trim();
      if (!q) break;
      return { kind: "query", id: q.toLocaleLowerCase(), q, at };
    }
    case "track": {
      const track = sanitizeTrack(r.track);
      return { kind: "track", id: track.id, track, at };
    }
    case "artist": {
      const a = sanitizeArtist(r);
      return { kind: "artist", id: a.id, name: a.name, thumb: a.thumb || a.art, at };
    }
    case "album": {
      const a = sanitizeAlbum(r);
      return { kind: "album", id: a.id, title: a.title, artist: a.artist, artistId: a.artistId, thumb: a.thumb || a.art, at };
    }
    case "playlist": {
      const p = sanitizeYtPlaylist(r);
      return { kind: "playlist", id: p.id, title: p.title, author: p.author, thumb: p.thumb || p.art, at };
    }
  }
  throw new HttpError(400, msg("invalidRecent"));
}

/** A recent list with this entry on top (once), at most RECENT_LIMIT long. */
export function withRecent(list: RecentItem[], item: RecentItem): RecentItem[] {
  return [item, ...list.filter((x) => x.kind !== item.kind || x.id !== item.id)].slice(0, RECENT_LIMIT);
}

/** What updateRadioPlaylist changes: any of them. */
export interface RadioPatch {
  tracks?: Track[];
  kept?: string[];
  discarded?: string[];
}

const RADIO_IDS = 500;
const idList = (input: unknown, limit = RADIO_IDS): string[] =>
  Array.isArray(input) ? [...new Set(input.filter((id): id is string => typeof id === "string" && VIDEO_ID.test(id)))].slice(-limit) : [];

/** A radio playlist's information as kept, or undefined for anything that isn't one. */
export function sanitizeRadio(input: unknown): RadioInfo | undefined {
  if (!input || typeof input !== "object") return undefined;
  const r = input as Record<string, unknown>;
  const seed = typeof r.seed === "string" && VIDEO_ID.test(r.seed) ? r.seed : "";
  if (!seed) return undefined;
  return { seed, kept: idList(r.kept), discarded: idList(r.discarded), edited: r.edited === true };
}

/** A patch from the app, checked. */
export function sanitizeRadioPatch(input: unknown): RadioPatch {
  const b = (input ?? {}) as Record<string, unknown>;
  const patch: RadioPatch = {};
  if (Array.isArray(b.tracks)) patch.tracks = cleanTracks(b.tracks.slice(0, 500));
  if (Array.isArray(b.kept)) patch.kept = idList(b.kept);
  if (Array.isArray(b.discarded)) patch.discarded = idList(b.discarded);
  return patch;
}

/** The patch on a radio playlist (in place): kept tracks that are still in it, and changed from now on. */
export function patchRadio(p: Playlist, patch: RadioPatch): void {
  if (!p.radio) throw new HttpError(409, msg("notRadioPlaylist"));
  if (patch.tracks) p.tracks = patch.tracks;
  if (patch.discarded) p.radio.discarded = patch.discarded;
  const inside = new Set(p.tracks.map((t) => t.id));
  p.radio.kept = (patch.kept ?? p.radio.kept).filter((id) => inside.has(id));
  p.radio.edited = true;
  p.updatedAt = Date.now();
}

/**
 * A radio playlist being saved (in place): the kept tracks only, and no radio information any more. False for one that
 * isn't a radio playlist (saved already, on another device or by a change sent twice): nothing to do.
 */
export function keepOnlyKept(p: Playlist): boolean {
  if (!p.radio) return false;
  const kept = new Set(p.radio.kept);
  const tracks = p.tracks.filter((t) => kept.has(t.id));
  if (!tracks.length) throw new HttpError(409, msg("radioNothingKept"));
  p.tracks = tracks;
  delete p.radio;
  p.updatedAt = Date.now();
  return true;
}

/** A playlist name as kept: trimmed, at most 80 characters, not empty. */
export function playlistName(name: string): string {
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new HttpError(400, msg("playlistNameRequired"));
  return clean;
}

/** Whether a track is by this artist: by artist page when the track knows it, by name otherwise. */
export function byArtist(track: Track, artistId: string, name: string): boolean {
  if (track.artistId) return track.artistId === artistId;
  const wanted = name.trim().toLocaleLowerCase();
  return !!wanted && track.artist.split(",").some((a) => a.trim().toLocaleLowerCase() === wanted);
}

/** One artist's entries from a play log, most played first (then most recent). */
export function rankPlays(plays: PlayEntry[], artistId: string, name: string, limit = 20): PlayEntry[] {
  return plays
    .filter((p) => byArtist(p.track, artistId, name))
    .sort((a, b) => b.count - a.count || b.lastPlayed - a.lastPlayed)
    .slice(0, limit);
}

// Backup import: a library exported from any Musike instance (web, desktop, another computer).

const MAX_PLAYLISTS = 1000;
const MAX_TRACKS = 5000;
/** Play log entries read from a backup (the server keeps them all; the JSON library keeps PLAYS_LIMIT). */
const MAX_IMPORT_PLAYS = 20_000;

/** Keeps the valid tracks of an untrusted list, without duplicates. */
function cleanTracks(input: unknown, limit = MAX_TRACKS): Track[] {
  return cleanList(input, sanitizeTrack, limit);
}

function sanitizePlay(input: unknown): PlayEntry & { id: string } {
  const p = (input ?? {}) as Record<string, unknown>;
  const track = sanitizeTrack(p.track);
  const count = typeof p.count === "number" && Number.isFinite(p.count) && p.count >= 1 ? Math.min(Math.floor(p.count), 1e6) : 1;
  return { id: track.id, track, count, lastPlayed: time(p.lastPlayed) };
}

function cleanPlays(input: unknown): PlayEntry[] {
  return cleanList(input, sanitizePlay, MAX_IMPORT_PLAYS).map(({ id: _id, ...entry }) => entry);
}

/** Keeps the valid entries of an untrusted list, without duplicates. */
function cleanList<T extends { id: string }>(input: unknown, sanitize: (raw: unknown) => T, limit = SAVED_LIMIT): T[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const raw of input.slice(0, limit * 2)) {
    try {
      const item = sanitize(raw);
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
      if (out.length >= limit) break;
    } catch {
      // skip invalid entries instead of rejecting the whole backup
    }
  }
  return out;
}

/** A backup's library, validated: invalid entries are dropped, missing lists are empty. */
export function cleanLibrary(input: unknown): Library {
  const lib = (input ?? {}) as Record<string, unknown>;
  const ids = new Set<string>();
  const playlists = (Array.isArray(lib.playlists) ? lib.playlists : []).slice(0, MAX_PLAYLISTS).flatMap((raw): Playlist[] => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const name = str(p.name, 80).trim();
    if (!name) return [];
    const now = Date.now();
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : now);
    const given = str(p.id, 64);
    // A missing, malformed or repeated id gets a new one: each playlist keeps its own.
    const id = /^[\w-]{8,64}$/.test(given) && !ids.has(given) ? given : randomUUID();
    ids.add(id);
    const radio = sanitizeRadio(p.radio);
    return [{ id, name, createdAt: num(p.createdAt), updatedAt: num(p.updatedAt), tracks: cleanTracks(p.tracks), ...(radio ? { radio } : {}) }];
  });
  return {
    favorites: cleanTracks(lib.favorites),
    playlists,
    history: cleanTracks(lib.history, HISTORY_LIMIT),
    artists: cleanList(lib.artists, sanitizeArtist),
    albums: cleanList(lib.albums, sanitizeAlbum),
    ytPlaylists: cleanList(lib.ytPlaylists, sanitizeYtPlaylist),
    plays: cleanPlays(lib.plays),
  };
}

export interface ImportResult {
  playlistsAdded: number;
  playlistsMerged: number;
  tracksAdded: number;
  favoritesAdded: number;
  artistsAdded: number;
  albumsAdded: number;
  ytPlaylistsAdded: number;
  playsAdded: number;
}

/**
 * Applies a cleaned backup to a library, in place, except the play log: each store merges that its own way
 * (a list of counts here, one row per play in SQLite). Counts what changed into `result`.
 */
export function importLists(lib: Library, incoming: Library, mode: "merge" | "replace"): ImportResult {
  const result: ImportResult = { playlistsAdded: 0, playlistsMerged: 0, tracksAdded: 0, favoritesAdded: 0, artistsAdded: 0, albumsAdded: 0, ytPlaylistsAdded: 0, playsAdded: 0 };

  if (mode === "replace") {
    lib.favorites = incoming.favorites;
    lib.playlists = incoming.playlists;
    lib.history = incoming.history;
    lib.artists = incoming.artists;
    lib.albums = incoming.albums;
    lib.ytPlaylists = incoming.ytPlaylists;
    result.playlistsAdded = incoming.playlists.length;
    result.favoritesAdded = incoming.favorites.length;
    result.artistsAdded = incoming.artists.length;
    result.albumsAdded = incoming.albums.length;
    result.ytPlaylistsAdded = incoming.ytPlaylists.length;
    result.tracksAdded = incoming.playlists.reduce((n, p) => n + p.tracks.length, 0);
    return result;
  }

  const union = <T extends { id: string }>(mine: T[], theirs: T[]) => {
    const have = new Set(mine.map((t) => t.id));
    const added = theirs.filter((t) => !have.has(t.id));
    return { list: [...mine, ...added], added: added.length };
  };

  const fav = union(lib.favorites, incoming.favorites);
  lib.favorites = fav.list;
  result.favoritesAdded = fav.added;

  for (const p of incoming.playlists) {
    const match =
      lib.playlists.find((x) => x.id === p.id) ??
      lib.playlists.find((x) => x.name.toLocaleLowerCase("pt-BR") === p.name.toLocaleLowerCase("pt-BR"));
    if (match) {
      const merged = union(match.tracks, p.tracks);
      if (!merged.added) continue; // already had every track: nothing changed
      match.tracks = merged.list.slice(0, MAX_TRACKS);
      match.updatedAt = Date.now();
      result.tracksAdded += merged.added;
      result.playlistsMerged++;
    } else {
      lib.playlists.push(p);
      result.tracksAdded += p.tracks.length;
      result.playlistsAdded++;
    }
  }

  const artists = union(lib.artists, incoming.artists);
  lib.artists = artists.list.slice(0, SAVED_LIMIT);
  result.artistsAdded = artists.added;
  const albums = union(lib.albums, incoming.albums);
  lib.albums = albums.list.slice(0, SAVED_LIMIT);
  result.albumsAdded = albums.added;
  const ytPlaylists = union(lib.ytPlaylists, incoming.ytPlaylists);
  lib.ytPlaylists = ytPlaylists.list.slice(0, SAVED_LIMIT);
  result.ytPlaylistsAdded = ytPlaylists.added;
  lib.history = union(lib.history, incoming.history).list.slice(0, HISTORY_LIMIT);
  return result;
}

/** The library as one JSON document (the Android and desktop apps). */
export function jsonLibrary(storage: LibraryStorage): LibraryStore {
  let state: Library | null = null;
  // Kept in the same document, next to the library (not part of it: backups leave it out).
  let recent: RecentItem[] = [];
  let writeChain: Promise<void> = Promise.resolve();

  async function load(): Promise<Library> {
    if (state) return state;
    const json = await storage.read();
    const lib = (json ? JSON.parse(json) : {}) as Partial<Library> & { recent?: RecentItem[] };
    recent = Array.isArray(lib.recent) ? lib.recent : [];
    // Libraries saved by older versions lack the newer lists.
    state = {
      favorites: lib.favorites ?? [],
      playlists: lib.playlists ?? [],
      history: lib.history ?? [],
      artists: lib.artists ?? [],
      albums: lib.albums ?? [],
      ytPlaylists: lib.ytPlaylists ?? [],
      plays: lib.plays ?? [],
    };
    return state;
  }

  /** Serialized writes so concurrent requests never interleave. */
  function persist(): Promise<void> {
    const snapshot = JSON.stringify({ ...state, recent }, null, 2);
    writeChain = writeChain.then(() => storage.write(snapshot));
    return writeChain;
  }

  function findPlaylist(lib: Library, pid: string): Playlist {
    const p = lib.playlists.find((x) => x.id === pid);
    if (!p) throw new HttpError(404, msg("playlistNotFound"));
    return p;
  }

  return {
    getLibrary: load,

    async getLibraryLite() {
      const { plays: _plays, ...rest } = await load();
      return rest;
    },

    async playsFor(artistId, name, limit = 20) {
      return rankPlays((await load()).plays, artistId, name, limit);
    },

    async allPlays() {
      return (await load()).plays;
    },

    async playLog(since, until) {
      const plays = (await load()).plays.filter((p) => p.lastPlayed >= since && p.lastPlayed <= until);
      return {
        rows: plays.map((p): PlayRow => [p.track.id, p.lastPlayed, p.count, 1]),
        tracks: plays.map((p) => p.track),
        dated: false,
      };
    },

    async firstPlay() {
      const plays = (await load()).plays;
      return plays.length ? Math.min(...plays.map((p) => p.lastPlayed)) : null;
    },

    async removeFromHistory(id) {
      const lib = await load();
      lib.history = lib.history.filter((t) => t.id !== id);
      await persist();
      return lib.history;
    },

    async forget(id) {
      const lib = await load();
      lib.history = lib.history.filter((t) => t.id !== id);
      lib.plays = lib.plays.filter((p) => p.track.id !== id);
      recent = recent.filter((x) => x.kind !== "track" || x.id !== id);
      await persist();
      return lib.history;
    },

    async topPlays(since, limit) {
      return (await load()).plays
        .filter((p) => p.lastPlayed >= since)
        .sort((a, b) => b.count - a.count || b.lastPlayed - a.lastPlayed)
        .slice(0, limit);
    },

    async addFavorite(track) {
      const lib = await load();
      lib.favorites = [track, ...lib.favorites.filter((t) => t.id !== track.id)];
      await persist();
      return lib.favorites;
    },

    async addFavorites(tracks) {
      const lib = await load();
      const seen = new Set(lib.favorites.map((t) => t.id));
      const added = tracks.filter((t) => !seen.has(t.id) && !!seen.add(t.id));
      lib.favorites = [...added, ...lib.favorites];
      await persist();
      return lib.favorites;
    },

    async removeFavorite(id) {
      const lib = await load();
      lib.favorites = lib.favorites.filter((t) => t.id !== id);
      await persist();
      return lib.favorites;
    },

    async saveArtist(artist) {
      const lib = await load();
      lib.artists = [{ ...artist, savedAt: Date.now() }, ...lib.artists.filter((a) => a.id !== artist.id)].slice(0, SAVED_LIMIT);
      await persist();
      return lib.artists;
    },

    async removeArtist(id) {
      const lib = await load();
      lib.artists = lib.artists.filter((a) => a.id !== id);
      await persist();
      return lib.artists;
    },

    async saveAlbum(album) {
      const lib = await load();
      lib.albums = [{ ...album, savedAt: Date.now() }, ...lib.albums.filter((a) => a.id !== album.id)].slice(0, SAVED_LIMIT);
      await persist();
      return lib.albums;
    },

    async removeAlbum(id) {
      const lib = await load();
      lib.albums = lib.albums.filter((a) => a.id !== id);
      await persist();
      return lib.albums;
    },

    async saveYtPlaylist(playlist) {
      const lib = await load();
      lib.ytPlaylists = [{ ...playlist, savedAt: Date.now() }, ...lib.ytPlaylists.filter((p) => p.id !== playlist.id)].slice(0, SAVED_LIMIT);
      await persist();
      return lib.ytPlaylists;
    },

    async removeYtPlaylist(id) {
      const lib = await load();
      lib.ytPlaylists = lib.ytPlaylists.filter((p) => p.id !== id);
      await persist();
      return lib.ytPlaylists;
    },

    async pushHistory(track, at) {
      const lib = await load();
      lib.history = [track, ...lib.history.filter((t) => t.id !== track.id)].slice(0, HISTORY_LIMIT);
      // A play (the app sends it once the track has really played, see the player) enters the history and the log.
      const before = lib.plays.find((p) => p.track.id === track.id);
      const when = playedAt(at);
      // The same play sent twice (queued offline, or sent again after a lost answer): counted once.
      if (before && at !== undefined && before.lastPlayed === when) {
        await persist();
        return lib.history;
      }
      lib.plays = [
        { track, count: (before?.count ?? 0) + 1, lastPlayed: Math.max(before?.lastPlayed ?? 0, when) },
        ...lib.plays.filter((p) => p.track.id !== track.id),
      ].slice(0, PLAYS_LIMIT);
      await persist();
      return lib.history;
    },

    async createPlaylist(name, tracks = []) {
      const lib = await load();
      const now = Date.now();
      const playlist: Playlist = { id: randomUUID(), name: playlistName(name), createdAt: now, updatedAt: now, tracks };
      lib.playlists.unshift(playlist);
      await persist();
      return playlist;
    },

    async renamePlaylist(pid, name) {
      const lib = await load();
      const p = findPlaylist(lib, pid);
      p.name = playlistName(name);
      p.updatedAt = Date.now();
      if (p.radio) p.radio.edited = true;
      await persist();
      return p;
    },

    async deletePlaylist(pid) {
      const lib = await load();
      findPlaylist(lib, pid);
      lib.playlists = lib.playlists.filter((p) => p.id !== pid);
      await persist();
    },

    async addToPlaylist(pid, tracks) {
      const lib = await load();
      const p = findPlaylist(lib, pid);
      for (const track of Array.isArray(tracks) ? tracks : [tracks]) {
        if (!p.tracks.some((t) => t.id === track.id)) p.tracks.push(track);
      }
      p.updatedAt = Date.now();
      if (p.radio) p.radio.edited = true;
      await persist();
      return p;
    },

    async removeFromPlaylist(pid, trackId) {
      const lib = await load();
      const p = findPlaylist(lib, pid);
      p.tracks = p.tracks.filter((t) => t.id !== trackId);
      p.updatedAt = Date.now();
      if (p.radio) {
        p.radio.edited = true;
        p.radio.kept = p.radio.kept.filter((id) => id !== trackId);
      }
      await persist();
      return p;
    },

    async reorderPlaylist(pid, ids) {
      const lib = await load();
      const p = findPlaylist(lib, pid);
      p.tracks = inOrder(p.tracks, ids);
      p.updatedAt = Date.now();
      if (p.radio) p.radio.edited = true;
      await persist();
      return p;
    },

    async createRadioPlaylist(name, seed, tracks) {
      const lib = await load();
      const now = Date.now();
      const playlist: Playlist = {
        id: randomUUID(),
        name: playlistName(name),
        createdAt: now,
        updatedAt: now,
        tracks,
        radio: { seed, kept: [], discarded: [], edited: false },
      };
      lib.playlists = [playlist, ...lib.playlists.filter((p) => !p.radio)];
      await persist();
      return playlist;
    },

    async updateRadioPlaylist(pid, patch) {
      const lib = await load();
      const p = findPlaylist(lib, pid);
      patchRadio(p, patch);
      await persist();
      return p;
    },

    async saveRadioPlaylist(pid) {
      const lib = await load();
      const p = findPlaylist(lib, pid);
      if (keepOnlyKept(p)) await persist();
      return p;
    },

    async importLibrary(input, mode) {
      const incoming = cleanLibrary(input);
      const lib = await load();
      const result = importLists(lib, incoming, mode);
      if (mode === "replace") {
        lib.plays = [...incoming.plays].sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, PLAYS_LIMIT);
        result.playsAdded = lib.plays.length;
      } else {
        // Play counts: the higher count and the later play win, so importing the same backup twice changes nothing.
        const plays = new Map(lib.plays.map((p) => [p.track.id, p]));
        for (const p of incoming.plays) {
          const mine = plays.get(p.track.id);
          if (!mine) result.playsAdded++;
          plays.set(p.track.id, mine ? { ...mine, count: Math.max(mine.count, p.count), lastPlayed: Math.max(mine.lastPlayed, p.lastPlayed) } : p);
        }
        lib.plays = [...plays.values()].sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, PLAYS_LIMIT);
      }
      await persist();
      return result;
    },

    async recent() {
      await load();
      return recent;
    },

    async pushRecent(item) {
      await load();
      recent = withRecent(recent, { ...item, at: Date.now() });
      await persist();
      return recent;
    },

    async removeRecent(kind, id) {
      await load();
      recent = recent.filter((x) => x.kind !== kind || x.id !== id);
      await persist();
      return recent;
    },

    async clearRecent() {
      await load();
      recent = [];
      await persist();
      return recent;
    },
  };
}
