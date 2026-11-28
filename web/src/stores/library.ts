import { create } from "zustand";
import { getT } from "../i18n";
import { api } from "../lib/api";
import type { Library, Playlist, SavedAlbum, SavedArtist, SavedYtPlaylist, Track } from "../lib/types";
import { toast } from "./ui";

interface LibraryState extends Library {
  status: "idle" | "loading" | "ready" | "error";
  load: () => Promise<void>;
  /** Fetches it again without showing it as loading (another device changed it). */
  refresh: () => Promise<void>;
  isFavorite: (id: string) => boolean;
  toggleFavorite: (t: Track) => Promise<void>;
  addFavorites: (tracks: Track[]) => Promise<void>;
  recordPlay: (t: Track) => void;
  /** Bumped whenever your plays change (a play, one removed or forgotten): what shows them fetches again. */
  playsVersion: number;
  /** Off Recently played only. */
  removeFromHistory: (id: string) => Promise<void>;
  /** Damnatio memoriae: every trace of the track's plays, gone. */
  forget: (id: string) => Promise<void>;
  toggleArtist: (a: SavedArtist) => Promise<void>;
  toggleAlbum: (a: SavedAlbum) => Promise<void>;
  toggleYtPlaylist: (p: SavedYtPlaylist) => Promise<void>;
  createPlaylist: (name: string, tracks?: Track[]) => Promise<Playlist | null>;
  renamePlaylist: (id: string, name: string) => Promise<void>;
  deletePlaylist: (id: string) => Promise<void>;
  addToPlaylist: (id: string, t: Track | Track[]) => Promise<void>;
  removeFromPlaylist: (id: string, trackId: string) => Promise<void>;
  /** The playlist's tracks in this order (shown at once, saved behind). */
  reorderPlaylist: (id: string, ids: string[]) => Promise<void>;
  /** Many at once (picked in a list): one notice for all. */
  removeFavorites: (ids: string[]) => Promise<void>;
  removeManyFromPlaylist: (id: string, trackIds: string[]) => Promise<void>;
  /** The radio playlist for a radio just started, with the tracks it queued (see the player's startRadio). */
  makeRadioPlaylist: (seed: Track, tracks: Track[]) => Promise<void>;
  /** A track of the radio playlist kept, or no longer kept. */
  toggleKeep: (id: string, trackId: string) => Promise<void>;
  /** The radio playlist's kept tracks, all at once (all of them, or none). */
  setKept: (id: string, trackIds: string[]) => Promise<void>;
  /** The radio playlist being regenerated (its id), while it is. */
  regenerating: string | null;
  /**
   * The tracks not kept give way to new ones, from the radio of the kept ones (the track it started from, with none
   * kept), as many as there were; tracks taken out before don't come back.
   */
  regenerateRadio: (id: string) => Promise<void>;
  /** The radio playlist as a playlist like the others. */
  /** Saved with its ticked tracks only (the others go): false when it couldn't be. */
  saveRadioPlaylist: (id: string) => Promise<boolean>;
}

/** Radios asked for at once while regenerating. */
const RADIO_SEEDS = 4;
/** Rounds of radios at most: each round's seeds come after the last's (see regenerateRadio). */
const RADIO_ROUNDS = 4;
/** A regenerated radio playlist has at least this many tracks. */
const RADIO_MIN = 25;

/** Up to `n` of the list, spread evenly over it. */
function spread<T>(list: T[], n: number): T[] {
  if (n <= 0) return [];
  if (list.length <= n) return list;
  if (n === 1) return [list[Math.floor(list.length / 2)]!];
  return Array.from({ length: n }, (_, i) => list[Math.round((i * (list.length - 1)) / (n - 1))]!);
}

const replacePlaylist = (list: Playlist[], p: Playlist) => list.map((x) => (x.id === p.id ? p : x));

export const useLibrary = create<LibraryState>((set, get) => ({
  favorites: [],
  playlists: [],
  history: [],
  artists: [],
  albums: [],
  ytPlaylists: [],
  status: "idle",
  regenerating: null,

  load: async () => {
    set({ status: "loading" });
    try {
      const lib = await api.library();
      // An older server sends no artists or albums.
      set({ ...lib, artists: lib.artists ?? [], albums: lib.albums ?? [], ytPlaylists: lib.ytPlaylists ?? [], status: "ready" });
    } catch {
      set({ status: "error" });
    }
  },

  refresh: async () => {
    try {
      const lib = await api.library();
      set({ ...lib, artists: lib.artists ?? [], albums: lib.albums ?? [], ytPlaylists: lib.ytPlaylists ?? [], status: "ready" });
    } catch {
      /* the next change, or the next start, brings it */
    }
  },

  isFavorite: (id) => get().favorites.some((t) => t.id === id),

  toggleFavorite: async (track) => {
    const prev = get().favorites;
    const on = !prev.some((t) => t.id === track.id);
    // Optimistic: the heart responds instantly, then reconciles with the server.
    set({ favorites: on ? [track, ...prev] : prev.filter((t) => t.id !== track.id) });
    try {
      const { favorites } = on ? await api.addFavorite(track) : await api.removeFavorite(track.id);
      set({ favorites });
      toast(on ? getT().toasts.addedFavorite : getT().toasts.removedFavorite);
    } catch (e) {
      set({ favorites: prev });
      toast((e as Error).message, "error");
    }
  },

  addFavorites: async (tracks) => {
    const prev = get().favorites;
    const fresh = tracks.filter((t) => !prev.some((f) => f.id === t.id));
    if (!fresh.length) return toast(getT().toasts.allAlreadyFavorites);
    set({ favorites: [...fresh, ...prev] });
    try {
      const { favorites } = await api.addFavorites(fresh);
      set({ favorites });
      toast(fresh.length === 1 ? getT().toasts.addedFavorite : getT().toasts.addedFavorites(fresh.length));
    } catch (e) {
      set({ favorites: prev });
      toast((e as Error).message, "error");
    }
  },

  toggleArtist: async (artist) => {
    const prev = get().artists;
    const on = !prev.some((a) => a.id === artist.id);
    set({ artists: on ? [artist, ...prev] : prev.filter((a) => a.id !== artist.id) });
    try {
      const { artists } = on ? await api.saveArtist(artist) : await api.removeArtist(artist.id);
      set({ artists });
      toast(on ? getT().toasts.savedToLibrary(artist.name) : getT().toasts.removedFromLibrary(artist.name));
    } catch (e) {
      set({ artists: prev });
      toast((e as Error).message, "error");
    }
  },

  toggleAlbum: async (album) => {
    const prev = get().albums;
    const on = !prev.some((a) => a.id === album.id);
    set({ albums: on ? [album, ...prev] : prev.filter((a) => a.id !== album.id) });
    try {
      const { albums } = on ? await api.saveAlbum(album) : await api.removeAlbum(album.id);
      set({ albums });
      toast(on ? getT().toasts.savedToLibrary(album.title) : getT().toasts.removedFromLibrary(album.title));
    } catch (e) {
      set({ albums: prev });
      toast((e as Error).message, "error");
    }
  },

  toggleYtPlaylist: async (playlist) => {
    const prev = get().ytPlaylists;
    const on = !prev.some((p) => p.id === playlist.id);
    set({ ytPlaylists: on ? [playlist, ...prev] : prev.filter((p) => p.id !== playlist.id) });
    try {
      const { ytPlaylists } = on ? await api.saveYtPlaylist(playlist) : await api.removeYtPlaylist(playlist.id);
      set({ ytPlaylists });
      toast(on ? getT().toasts.savedToLibrary(playlist.title) : getT().toasts.removedFromLibrary(playlist.title));
    } catch (e) {
      set({ ytPlaylists: prev });
      toast((e as Error).message, "error");
    }
  },

  recordPlay: (track) => {
    set((s) => ({ history: [track, ...s.history.filter((t) => t.id !== track.id)].slice(0, 60), playsVersion: s.playsVersion + 1 }));
    // With the time it was played: sent again (queued offline, or after an answer that got lost), the server knows
    // it's the same play.
    api.pushHistory(track, Date.now()).catch(() => {});
  },

  playsVersion: 0,

  removeFromHistory: async (id) => {
    const before = get().history;
    set((s) => ({ history: s.history.filter((t) => t.id !== id), playsVersion: s.playsVersion + 1 }));
    try {
      set({ history: (await api.removeFromHistory(id)).history });
      toast(getT().forget.removed);
    } catch (e) {
      set({ history: before });
      toast((e as Error).message || getT().forget.failed, "error");
    }
  },

  forget: async (id) => {
    const before = get().history;
    set((s) => ({ history: s.history.filter((t) => t.id !== id), playsVersion: s.playsVersion + 1 }));
    try {
      const { history } = await api.forget(id);
      set((s) => ({ history, playsVersion: s.playsVersion + 1 }));
      toast(getT().forget.forgotten);
    } catch (e) {
      set({ history: before });
      toast((e as Error).message || getT().forget.failed, "error");
    }
  },

  createPlaylist: async (name, tracks = []) => {
    try {
      const p = await api.createPlaylist(name, tracks);
      set((s) => ({ playlists: [p, ...s.playlists] }));
      toast(getT().toasts.playlistCreated(p.name));
      return p;
    } catch (e) {
      toast((e as Error).message, "error");
      return null;
    }
  },

  makeRadioPlaylist: async (seed, tracks) => {
    try {
      const p = await api.createRadioPlaylist(getT().radio.playlistName(seed.title), seed.id, tracks);
      // One at a time: the one there was went on the server too.
      set((s) => ({ playlists: [p, ...s.playlists.filter((x) => !x.radio && x.id !== p.id)] }));
    } catch {
      /* an older server: the radio plays all the same, without its playlist */
    }
  },

  toggleKeep: async (id, trackId) => {
    const p = get().playlists.find((x) => x.id === id);
    if (!p?.radio) return;
    await get().setKept(id, p.radio.kept.includes(trackId) ? p.radio.kept.filter((k) => k !== trackId) : [...p.radio.kept, trackId]);
  },

  setKept: async (id, kept) => {
    const prev = get().playlists;
    const p = prev.find((x) => x.id === id);
    if (!p?.radio) return;
    // At once here; the server's copy follows, and the other devices with it.
    set({ playlists: replacePlaylist(prev, { ...p, radio: { ...p.radio, kept, edited: true } }) });
    try {
      const updated = await api.updateRadioPlaylist(id, { kept });
      set((s) => ({ playlists: replacePlaylist(s.playlists, updated) }));
    } catch (e) {
      set({ playlists: prev });
      toast((e as Error).message, "error");
    }
  },

  regenerateRadio: async (id) => {
    const p = get().playlists.find((x) => x.id === id);
    if (!p?.radio || get().regenerating) return;
    const radio = p.radio;
    const keptIds = new Set(radio.kept);
    const kept = p.tracks.filter((t) => keptIds.has(t.id));
    const dropped = p.tracks.filter((t) => !keptIds.has(t.id));
    set({ regenerating: id });
    try {
      const want = Math.max(p.tracks.length, RADIO_MIN) - kept.length;
      // What can't come in: the kept tracks (they stay), the ones going out now and the ones out before.
      const out = new Set([...keptIds, ...radio.discarded, ...dropped.map((t) => t.id)]);
      const fresh: Track[] = [];
      // Radios to ask, in order: the kept tracks first (they're what the new ones should be like), then the ones
      // going out and the track it started from, then the new ones found. A track out of the playlist can still lead
      // to others: a single track's radio is mostly what's already here (or was), and alone ran dry in a few rounds.
      const found: string[] = [];
      const groups = [kept.map((t) => t.id), [...new Set([radio.seed, ...dropped.map((t) => t.id)])], found];
      const asked = new Set<string>();
      /** The next radios to ask: from the first group with some left, spread over it, topped up from the next. */
      const nextBatch = () => {
        const batch: string[] = [];
        for (const group of groups) {
          const left = group.filter((s) => !asked.has(s) && !batch.includes(s));
          batch.push(...spread(left, RADIO_SEEDS - batch.length));
          if (batch.length >= RADIO_SEEDS) break;
        }
        return batch;
      };
      for (let round = 0; round < RADIO_ROUNDS && fresh.length < want; round++) {
        const batch = nextBatch();
        if (!batch.length) break;
        batch.forEach((s) => asked.add(s));
        const lists = await Promise.all(batch.map((s) => api.radio(s).catch(() => [] as Track[])));
        // A little from each radio in turn, so all of them count.
        for (let i = 0; fresh.length < want && lists.some((l) => i < l.length); i++) {
          for (const list of lists) {
            const t = list[i];
            if (!t || out.has(t.id)) continue;
            out.add(t.id);
            fresh.push(t);
            found.push(t.id);
            if (fresh.length >= want) break;
          }
        }
      }
      if (!fresh.length) {
        toast(getT().radio.nothingNew);
        return;
      }
      const updated = await api.updateRadioPlaylist(id, {
        tracks: [...kept, ...fresh],
        kept: [...keptIds],
        discarded: [...radio.discarded, ...dropped.map((t) => t.id)],
      });
      set((s) => ({ playlists: replacePlaylist(s.playlists, updated) }));
      toast(getT().radio.regenerated(fresh.length));
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      set({ regenerating: null });
    }
  },

  saveRadioPlaylist: async (id) => {
    try {
      const p = await api.saveRadioPlaylist(id);
      set((s) => ({ playlists: replacePlaylist(s.playlists, p) }));
      toast(getT().radio.saved(p.name, p.tracks.length));
      return true;
    } catch (e) {
      toast((e as Error).message, "error");
      return false;
    }
  },

  renamePlaylist: async (id, name) => {
    try {
      const p = await api.renamePlaylist(id, name);
      set((s) => ({ playlists: replacePlaylist(s.playlists, p) }));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  },

  deletePlaylist: async (id) => {
    const prev = get().playlists;
    set({ playlists: prev.filter((p) => p.id !== id) });
    try {
      await api.deletePlaylist(id);
      toast(getT().toasts.playlistDeleted);
    } catch (e) {
      set({ playlists: prev });
      toast((e as Error).message, "error");
    }
  },

  addToPlaylist: async (id, tracks) => {
    try {
      const before = get().playlists.find((p) => p.id === id)?.tracks.length ?? 0;
      const p = await api.addToPlaylist(id, tracks);
      set((s) => ({ playlists: replacePlaylist(s.playlists, p) }));
      const added = p.tracks.length - before;
      const t = getT();
      if (!Array.isArray(tracks) || added === 1) toast(t.toasts.addedTo(p.name));
      else toast(added ? t.toasts.addedManyTo(added, p.name) : t.toasts.allAlreadyIn(p.name));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  },

  removeFavorites: async (ids) => {
    const prev = get().favorites;
    const gone = new Set(ids);
    set({ favorites: prev.filter((t) => !gone.has(t.id)) });
    try {
      let favorites = prev;
      for (const id of ids) ({ favorites } = await api.removeFavorite(id));
      set({ favorites });
      toast(getT().toasts.removedFavorites(ids.length));
    } catch (e) {
      toast((e as Error).message, "error");
      void get().load(); // some may be gone already: show what the server has
    }
  },

  removeManyFromPlaylist: async (id, trackIds) => {
    const prev = get().playlists;
    const gone = new Set(trackIds);
    set({ playlists: prev.map((p) => (p.id === id ? { ...p, tracks: p.tracks.filter((t) => !gone.has(t.id)) } : p)) });
    try {
      let last: Playlist | null = null;
      for (const trackId of trackIds) last = await api.removeFromPlaylist(id, trackId);
      if (last) set((s) => ({ playlists: replacePlaylist(s.playlists, last!) }));
      toast(getT().toasts.removedFromPlaylist(trackIds.length));
    } catch (e) {
      toast((e as Error).message, "error");
      void get().load();
    }
  },

  reorderPlaylist: async (id, ids) => {
    const prev = get().playlists;
    const at = new Map(ids.map((tid, i) => [tid, i]));
    set({
      playlists: prev.map((p) =>
        p.id === id ? { ...p, tracks: [...p.tracks].sort((a, b) => (at.get(a.id) ?? 1e9) - (at.get(b.id) ?? 1e9)) } : p,
      ),
    });
    try {
      const p = await api.reorderPlaylist(id, ids);
      set((s) => ({ playlists: replacePlaylist(s.playlists, p) }));
    } catch (e) {
      set({ playlists: prev });
      toast((e as Error).message, "error");
    }
  },

  removeFromPlaylist: async (id, trackId) => {
    const prev = get().playlists;
    set({
      playlists: prev.map((p) => (p.id === id ? { ...p, tracks: p.tracks.filter((t) => t.id !== trackId) } : p)),
    });
    try {
      const p = await api.removeFromPlaylist(id, trackId);
      set((s) => ({ playlists: replacePlaylist(s.playlists, p) }));
    } catch (e) {
      set({ playlists: prev });
      toast((e as Error).message, "error");
    }
  },
}));
