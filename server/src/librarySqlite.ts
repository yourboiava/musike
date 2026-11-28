import { type Db, type Param, type Row, transaction } from "./db.js";
import { msg } from "./i18n.js";
import {
  cleanLibrary,
  HISTORY_LIMIT,
  importLists,
  inOrder,
  keepOnlyKept,
  type LibraryStore,
  PLAY_LOG_LIMIT,
  playedAt,
  type PlayRow,
  patchRadio,
  playlistName,
  sanitizeRadio,
  randomUUID,
  rankPlays,
  RECENT_LIMIT,
  SAVED_LIMIT,
} from "./library.js";
import {
  HttpError,
  type Library,
  type PlayEntry,
  type Playlist,
  type RecentItem,
  type SavedAlbum,
  type SavedArtist,
  type SavedYtPlaylist,
  type Track,
} from "./types.js";

// The library in SQLite (see db.ts for the tables). Behaves like jsonLibrary in library.ts, one user at a time.

/** JSON kept in a column, or null if it doesn't read. */
const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

const TRACK_COLS = "t.id, t.title, t.artist, t.album, t.artist_id, t.album_id, t.duration, t.thumb, t.art, t.kind";

/** Same keys, same order as sanitizeTrack. */
function toTrack(r: Row): Track {
  return {
    id: String(r.id),
    title: String(r.title),
    artist: String(r.artist),
    album: (r.album as string | null) ?? undefined,
    artistId: (r.artist_id as string | null) ?? undefined,
    albumId: (r.album_id as string | null) ?? undefined,
    duration: Number(r.duration),
    thumb: String(r.thumb),
    art: String(r.art),
    kind: r.kind === "video" ? "video" : "song",
  };
}

/** A column for each key of a saved item, in the item's key order. */
type Fields = [key: string, column: string][];

const ARTIST_FIELDS: Fields = [["id", "id"], ["name", "name"], ["thumb", "thumb"], ["art", "art"], ["savedAt", "saved_at"]];
const ALBUM_FIELDS: Fields = [
  ["id", "id"],
  ["title", "title"],
  ["artist", "artist"],
  ["artistId", "artist_id"],
  ["year", "year"],
  ["thumb", "thumb"],
  ["art", "art"],
  ["savedAt", "saved_at"],
];
const YT_PLAYLIST_FIELDS: Fields = [["id", "id"], ["title", "title"], ["author", "author"], ["thumb", "thumb"], ["art", "art"], ["savedAt", "saved_at"]];

/** The library of every user in one database. Statements are prepared once and shared by all users. */
export function sqliteLibraries(db: Db): { forUser(userId: number): LibraryStore } {
  const q = (sql: string) => db.prepare(sql);
  const rows = (sql: string) => {
    const s = q(sql);
    return (...params: Param[]) => s.all(...params) as Row[];
  };
  const one = (sql: string) => {
    const s = q(sql);
    return (...params: Param[]) => s.get(...params) as Row | undefined;
  };
  const run = (sql: string) => {
    const s = q(sql);
    return (...params: Param[]) => void s.run(...params);
  };

  const upsertTrackStmt = run(`
    INSERT INTO tracks (id, title, artist, album, artist_id, album_id, duration, thumb, art, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      title = excluded.title,
      artist = excluded.artist,
      -- an older copy can know more: never trade a known value for a missing one
      album = COALESCE(excluded.album, album),
      artist_id = COALESCE(excluded.artist_id, artist_id),
      album_id = COALESCE(excluded.album_id, album_id),
      duration = CASE WHEN excluded.duration > 0 THEN excluded.duration ELSE duration END,
      thumb = CASE WHEN excluded.thumb <> '' THEN excluded.thumb ELSE thumb END,
      art = CASE WHEN excluded.art <> '' THEN excluded.art ELSE art END,
      kind = excluded.kind`);
  const upsertTrack = (t: Track) =>
    upsertTrackStmt(t.id, t.title, t.artist, t.album ?? null, t.artistId ?? null, t.albumId ?? null, t.duration, t.thumb, t.art, t.kind);

  /** An ordered list of tracks per user: favorites, history. */
  function trackList(table: "favorites" | "history") {
    const all = rows(`SELECT ${TRACK_COLS} FROM ${table} l JOIN tracks t ON t.id = l.track_id WHERE l.user_id = ? ORDER BY l.pos`);
    const ids = rows(`SELECT track_id FROM ${table} WHERE user_id = ?`);
    const top = one(`SELECT COALESCE(MIN(pos), 0) AS v FROM ${table} WHERE user_id = ?`);
    const put = run(`INSERT INTO ${table} (user_id, track_id, pos) VALUES (?, ?, ?) ON CONFLICT (user_id, track_id) DO UPDATE SET pos = excluded.pos`);
    const remove = run(`DELETE FROM ${table} WHERE user_id = ? AND track_id = ?`);
    const clear = run(`DELETE FROM ${table} WHERE user_id = ?`);
    const trim = run(`DELETE FROM ${table} WHERE user_id = ? AND track_id NOT IN (SELECT track_id FROM ${table} WHERE user_id = ? ORDER BY pos LIMIT ?)`);
    return {
      list: (uid: number) => all(uid).map(toTrack),
      ids: (uid: number) => new Set(ids(uid).map((r) => String(r.track_id))),
      /** Puts these on top, in this order (moving the ones already there). */
      putOnTop(uid: number, tracks: Track[]) {
        const start = Number(top(uid)!.v) - tracks.length;
        tracks.forEach((t, i) => {
          upsertTrack(t);
          put(uid, t.id, start + i);
        });
      },
      remove: (uid: number, id: string) => remove(uid, id),
      trim: (uid: number, limit: number) => trim(uid, uid, limit),
      replaceAll(uid: number, tracks: Track[]) {
        clear(uid);
        tracks.forEach((t, i) => {
          upsertTrack(t);
          put(uid, t.id, i);
        });
      },
    };
  }

  /** Artists, albums or YouTube playlists kept per user, newest on top. */
  function savedList<T extends { id: string }>(table: string, fields: Fields) {
    const cols = fields.map(([, c]) => c);
    const all = rows(`SELECT ${cols.join(", ")} FROM ${table} WHERE user_id = ? ORDER BY pos`);
    const top = one(`SELECT COALESCE(MIN(pos), 0) AS v FROM ${table} WHERE user_id = ?`);
    const put = run(`
      INSERT INTO ${table} (user_id, pos, ${cols.join(", ")}) VALUES (?, ?, ${cols.map(() => "?").join(", ")})
      ON CONFLICT (user_id, id) DO UPDATE SET pos = excluded.pos, ${cols
        .filter((c) => c !== "id")
        .map((c) => `${c} = excluded.${c}`)
        .join(", ")}`);
    const remove = run(`DELETE FROM ${table} WHERE user_id = ? AND id = ?`);
    const clear = run(`DELETE FROM ${table} WHERE user_id = ?`);
    const trim = run(`DELETE FROM ${table} WHERE user_id = ? AND id NOT IN (SELECT id FROM ${table} WHERE user_id = ? ORDER BY pos LIMIT ?)`);
    const values = (item: T) => fields.map(([k]) => ((item as Record<string, unknown>)[k] ?? null) as Param);
    const toItem = (r: Row) => Object.fromEntries(fields.map(([k, c]) => [k, r[c] ?? undefined])) as unknown as T;
    return {
      list: (uid: number) => all(uid).map(toItem),
      save(uid: number, item: T) {
        put(uid, Number(top(uid)!.v) - 1, ...values(item));
        trim(uid, uid, SAVED_LIMIT);
      },
      remove: (uid: number, id: string) => remove(uid, id),
      replaceAll(uid: number, items: T[]) {
        clear(uid);
        items.forEach((item, i) => put(uid, i, ...values(item)));
      },
    };
  }

  const favorites = trackList("favorites");
  const history = trackList("history");
  const artists = savedList<SavedArtist>("saved_artists", ARTIST_FIELDS);
  const albums = savedList<SavedAlbum>("saved_albums", ALBUM_FIELDS);
  const ytPlaylists = savedList<SavedYtPlaylist>("saved_yt_playlists", YT_PLAYLIST_FIELDS);

  // Playlists

  const plAll = rows(`SELECT id, name, created_at, updated_at, radio FROM playlists WHERE user_id = ? ORDER BY pos`);
  const plOne = one(`SELECT id, name, created_at, updated_at, radio FROM playlists WHERE user_id = ? AND id = ?`);
  const plTop = one(`SELECT COALESCE(MIN(pos), 0) AS v FROM playlists WHERE user_id = ?`);
  const plInsert = run(`INSERT INTO playlists (user_id, id, name, created_at, updated_at, pos, radio) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const plRadio = run(`UPDATE playlists SET radio = ?, updated_at = ? WHERE user_id = ? AND id = ?`);
  const plRadioIds = rows(`SELECT id FROM playlists WHERE user_id = ? AND radio IS NOT NULL`);
  const ptClear = run(`DELETE FROM playlist_tracks WHERE user_id = ? AND playlist_id = ?`);
  const plRename = run(`UPDATE playlists SET name = ?, updated_at = ? WHERE user_id = ? AND id = ?`);
  const plTouch = run(`UPDATE playlists SET updated_at = ? WHERE user_id = ? AND id = ?`);
  const plDelete = run(`DELETE FROM playlists WHERE user_id = ? AND id = ?`);
  const plClear = run(`DELETE FROM playlists WHERE user_id = ?`);
  const ptOf = rows(
    `SELECT ${TRACK_COLS} FROM playlist_tracks l JOIN tracks t ON t.id = l.track_id WHERE l.user_id = ? AND l.playlist_id = ? ORDER BY l.pos`,
  );
  const ptAll = rows(
    `SELECT l.playlist_id, ${TRACK_COLS} FROM playlist_tracks l JOIN tracks t ON t.id = l.track_id WHERE l.user_id = ? ORDER BY l.pos`,
  );
  const ptBottom = one(`SELECT COALESCE(MAX(pos), -1) AS v FROM playlist_tracks WHERE user_id = ? AND playlist_id = ?`);
  const ptInsert = run(`INSERT OR IGNORE INTO playlist_tracks (user_id, playlist_id, track_id, pos) VALUES (?, ?, ?, ?)`);
  const ptRemove = run(`DELETE FROM playlist_tracks WHERE user_id = ? AND playlist_id = ? AND track_id = ?`);
  const ptMove = run(`UPDATE playlist_tracks SET pos = ? WHERE user_id = ? AND playlist_id = ? AND track_id = ?`);

  const toPlaylist = (r: Row, tracks: Track[]): Playlist => {
    const radio = r.radio == null ? undefined : sanitizeRadio(safeJson(String(r.radio)));
    return {
      id: String(r.id),
      name: String(r.name),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      tracks,
      ...(radio ? { radio } : {}),
    };
  };

  /** A change to a radio playlist marks it changed (starting another radio asks before deleting it). */
  function touched(uid: number, pid: string) {
    const p = playlist(uid, pid);
    if (p.radio) plRadio(JSON.stringify({ ...p.radio, edited: true }), Date.now(), uid, pid);
    else plTouch(Date.now(), uid, pid);
  }

  function playlist(uid: number, pid: string): Playlist {
    const r = plOne(uid, pid);
    if (!r) throw new HttpError(404, msg("playlistNotFound"));
    return toPlaylist(r, ptOf(uid, pid).map(toTrack));
  }

  function playlists(uid: number): Playlist[] {
    const byList = new Map<string, Track[]>();
    for (const r of ptAll(uid)) {
      const id = String(r.playlist_id);
      if (!byList.has(id)) byList.set(id, []);
      byList.get(id)!.push(toTrack(r));
    }
    return plAll(uid).map((r) => toPlaylist(r, byList.get(String(r.id)) ?? []));
  }

  function insertPlaylist(uid: number, p: Playlist, pos: number) {
    plInsert(uid, p.id, p.name, p.createdAt, p.updatedAt, pos, p.radio ? JSON.stringify(p.radio) : null);
    p.tracks.forEach((t, i) => {
      upsertTrack(t);
      ptInsert(uid, p.id, t.id, i);
    });
  }

  // Play log: one row per play, summed per track.

  const PLAY_SUMS = `SELECT ${TRACK_COLS}, SUM(p.count) AS plays, MAX(p.played_at) AS last FROM plays p JOIN tracks t ON t.id = p.track_id`;
  // Most recent first; plays in the same millisecond by the order they were saved.
  const RECENT = "ORDER BY last DESC, MAX(p.id) DESC";
  const playsAll = rows(`${PLAY_SUMS} WHERE p.user_id = ? GROUP BY p.track_id ${RECENT}`);
  // Since a time: only the plays made in the app (one row each, dated); ever: those restored from backups too.
  const playsSince = rows(
    `${PLAY_SUMS} WHERE p.user_id = ? AND p.played_at >= ? AND p.source = 'app' GROUP BY p.track_id ORDER BY plays DESC, last DESC LIMIT ?`,
  );
  const playsEver = rows(`${PLAY_SUMS} WHERE p.user_id = ? GROUP BY p.track_id ORDER BY plays DESC, last DESC LIMIT ?`);
  const firstPlayed = db.prepare("SELECT MIN(played_at) AS first FROM plays WHERE user_id = ?");
  const logRows = db.prepare(
    `SELECT track_id AS tid, played_at AS at, count AS n, source FROM plays WHERE user_id = ? AND played_at BETWEEN ? AND ? ORDER BY played_at, rowid LIMIT ${PLAY_LOG_LIMIT}`,
  );
  const logTracks = rows(
    `SELECT ${TRACK_COLS} FROM tracks t WHERE t.id IN (SELECT DISTINCT track_id FROM plays WHERE user_id = ? AND played_at BETWEEN ? AND ?)`,
  );
  const playsForget = db.prepare("DELETE FROM plays WHERE user_id = ? AND track_id = ?");
  const recentForget = db.prepare("DELETE FROM recent WHERE user_id = ? AND kind = 'track' AND id = ?");
  // Tracks that name this artist page, and the ones that name no page at all (matched by name in rankPlays).
  const playsMaybeBy = rows(`${PLAY_SUMS} WHERE p.user_id = ? AND (t.artist_id = ? OR t.artist_id IS NULL) GROUP BY p.track_id ${RECENT}`);
  const playsOf = one(`SELECT COUNT(*) AS rows, COALESCE(SUM(count), 0) AS n, COALESCE(MAX(played_at), 0) AS last FROM plays WHERE user_id = ? AND track_id = ?`);
  const playInsert = run(`INSERT INTO plays (user_id, track_id, played_at, count, source) VALUES (?, ?, ?, ?, ?)`);
  const playSeenStmt = db.prepare(`SELECT 1 FROM plays WHERE user_id = ? AND track_id = ? AND played_at = ? LIMIT 1`);
  const playSeen = (uid: number, trackId: string, at: number) => playSeenStmt.get(uid, trackId, at) !== undefined;
  const playsClear = run(`DELETE FROM plays WHERE user_id = ?`);
  const toPlay = (r: Row): PlayEntry => ({ track: toTrack(r), count: Number(r.plays), lastPlayed: Number(r.last) });

  // Recent list: one row per entry; a new one gets a new rowid, so entries saved in the same millisecond keep order.

  const recentAll = rows(`SELECT data, at FROM recent WHERE user_id = ? ORDER BY at DESC, rowid DESC`);
  const recentDelete = run(`DELETE FROM recent WHERE user_id = ? AND kind = ? AND id = ?`);
  const recentInsert = run(`INSERT INTO recent (user_id, kind, id, data, at) VALUES (?, ?, ?, ?, ?)`);
  const recentClear = run(`DELETE FROM recent WHERE user_id = ?`);
  const recentTrim = run(
    `DELETE FROM recent WHERE user_id = ? AND rowid NOT IN (SELECT rowid FROM recent WHERE user_id = ? ORDER BY at DESC, rowid DESC LIMIT ?)`,
  );
  const recentList = (uid: number): RecentItem[] =>
    recentAll(uid).map((r) => ({ ...(JSON.parse(String(r.data)) as RecentItem), at: Number(r.at) }));

  function readLibrary(uid: number): Library {
    return {
      favorites: favorites.list(uid),
      playlists: playlists(uid),
      history: history.list(uid),
      artists: artists.list(uid),
      albums: albums.list(uid),
      ytPlaylists: ytPlaylists.list(uid),
      plays: playsAll(uid).map(toPlay),
    };
  }

  const tx = <T>(fn: () => T): Promise<T> => {
    try {
      return Promise.resolve(transaction(db, fn));
    } catch (e) {
      return Promise.reject(e);
    }
  };

  return {
    forUser(uid: number): LibraryStore {
      return {
        getLibrary: () => tx(() => readLibrary(uid)),

        getLibraryLite: () =>
          tx(() => {
            const { plays: _plays, ...rest } = readLibrary(uid);
            return rest;
          }),

        playsFor: (artistId, name, limit = 20) => tx(() => rankPlays(playsMaybeBy(uid, artistId).map(toPlay), artistId, name, limit)),

        allPlays: () => tx(() => playsAll(uid).map(toPlay)),

        playLog: (since, until) =>
          tx(() => ({
            rows: (logRows.all(uid, since, until) as { tid: string; at: number; n: number; source: string }[]).map(
              (r): PlayRow => [r.tid, Number(r.at), Number(r.n), r.source === "import" ? 1 : 0],
            ),
            tracks: logTracks(uid, since, until).map(toTrack),
            dated: true,
          })),

        firstPlay: () => tx(() => ((firstPlayed.get(uid) as { first: number | null } | undefined)?.first ?? null)),

        removeFromHistory: (id) =>
          tx(() => {
            history.remove(uid, id);
            return history.list(uid);
          }),

        forget: (id) =>
          tx(() => {
            history.remove(uid, id);
            playsForget.run(uid, id);
            recentForget.run(uid, id);
            return history.list(uid);
          }),

        topPlays: (since, limit) => tx(() => (since > 0 ? playsSince(uid, since, limit) : playsEver(uid, limit)).map(toPlay)),

        addFavorite: (track) =>
          tx(() => {
            favorites.putOnTop(uid, [track]);
            return favorites.list(uid);
          }),

        addFavorites: (tracks) =>
          tx(() => {
            const seen = favorites.ids(uid);
            favorites.putOnTop(uid, tracks.filter((t) => !seen.has(t.id) && !!seen.add(t.id)));
            return favorites.list(uid);
          }),

        removeFavorite: (id) =>
          tx(() => {
            favorites.remove(uid, id);
            return favorites.list(uid);
          }),

        saveArtist: (artist) =>
          tx(() => {
            artists.save(uid, { ...artist, savedAt: Date.now() });
            return artists.list(uid);
          }),

        removeArtist: (id) =>
          tx(() => {
            artists.remove(uid, id);
            return artists.list(uid);
          }),

        saveAlbum: (album) =>
          tx(() => {
            albums.save(uid, { ...album, savedAt: Date.now() });
            return albums.list(uid);
          }),

        removeAlbum: (id) =>
          tx(() => {
            albums.remove(uid, id);
            return albums.list(uid);
          }),

        saveYtPlaylist: (playlist) =>
          tx(() => {
            ytPlaylists.save(uid, { ...playlist, savedAt: Date.now() });
            return ytPlaylists.list(uid);
          }),

        removeYtPlaylist: (id) =>
          tx(() => {
            ytPlaylists.remove(uid, id);
            return ytPlaylists.list(uid);
          }),

        pushHistory: (track, at) =>
          tx(() => {
            history.putOnTop(uid, [track]);
            history.trim(uid, HISTORY_LIMIT);
            // A play (the app sends it once the track has really played, see the player) enters the history and the log,
            // at the time it was played when given.
            // The same play sent twice (queued offline, or sent again after a lost answer) is logged once.
            const when = playedAt(at);
            if (at === undefined || !playSeen(uid, track.id, when)) playInsert(uid, track.id, when, 1, "app");
            return history.list(uid);
          }),

        createPlaylist: (name, tracks = []) =>
          tx(() => {
            const now = Date.now();
            const p: Playlist = { id: randomUUID(), name: playlistName(name), createdAt: now, updatedAt: now, tracks };
            insertPlaylist(uid, p, Number(plTop(uid)!.v) - 1);
            return playlist(uid, p.id);
          }),

        renamePlaylist: (pid, name) =>
          tx(() => {
            playlist(uid, pid);
            plRename(playlistName(name), Date.now(), uid, pid);
            touched(uid, pid);
            return playlist(uid, pid);
          }),

        deletePlaylist: (pid) =>
          tx(() => {
            playlist(uid, pid);
            plDelete(uid, pid);
          }),

        addToPlaylist: (pid, tracks) =>
          tx(() => {
            playlist(uid, pid);
            let pos = Number(ptBottom(uid, pid)!.v);
            for (const t of Array.isArray(tracks) ? tracks : [tracks]) {
              upsertTrack(t);
              ptInsert(uid, pid, t.id, ++pos); // already there: ignored
            }
            touched(uid, pid);
            return playlist(uid, pid);
          }),

        removeFromPlaylist: (pid, trackId) =>
          tx(() => {
            const p = playlist(uid, pid);
            ptRemove(uid, pid, trackId);
            if (p.radio) plRadio(JSON.stringify({ ...p.radio, kept: p.radio.kept.filter((id) => id !== trackId), edited: true }), Date.now(), uid, pid);
            else plTouch(Date.now(), uid, pid);
            return playlist(uid, pid);
          }),

        reorderPlaylist: (pid, ids) =>
          tx(() => {
            const current = playlist(uid, pid);
            inOrder(current.tracks, ids).forEach((t, pos) => ptMove(pos, uid, pid, t.id));
            touched(uid, pid);
            return playlist(uid, pid);
          }),

        createRadioPlaylist: (name, seed, tracks) =>
          tx(() => {
            // One radio playlist at a time: the one there was, not saved, goes.
            for (const r of plRadioIds(uid)) plDelete(uid, String(r.id));
            const now = Date.now();
            const p: Playlist = {
              id: randomUUID(),
              name: playlistName(name),
              createdAt: now,
              updatedAt: now,
              tracks,
              radio: { seed, kept: [], discarded: [], edited: false },
            };
            insertPlaylist(uid, p, Number(plTop(uid)!.v) - 1);
            return playlist(uid, p.id);
          }),

        updateRadioPlaylist: (pid, patch) =>
          tx(() => {
            const p = playlist(uid, pid);
            patchRadio(p, patch);
            if (patch.tracks) {
              ptClear(uid, pid);
              p.tracks.forEach((t, i) => {
                upsertTrack(t);
                ptInsert(uid, pid, t.id, i);
              });
            }
            plRadio(JSON.stringify(p.radio), p.updatedAt, uid, pid);
            return playlist(uid, pid);
          }),

        saveRadioPlaylist: (pid) =>
          tx(() => {
            const p = playlist(uid, pid);
            if (!keepOnlyKept(p)) return p;
            ptClear(uid, pid);
            p.tracks.forEach((t, i) => ptInsert(uid, pid, t.id, i));
            plRadio(null, p.updatedAt, uid, pid);
            return playlist(uid, pid);
          }),

        importLibrary: (input, mode) => {
          const incoming = cleanLibrary(input);
          return tx(() => {
            // The lists merge exactly as in the JSON library, then are written back whole.
            const lib = readLibrary(uid);
            const result = importLists(lib, incoming, mode);
            favorites.replaceAll(uid, lib.favorites);
            history.replaceAll(uid, lib.history);
            artists.replaceAll(uid, lib.artists);
            albums.replaceAll(uid, lib.albums);
            ytPlaylists.replaceAll(uid, lib.ytPlaylists);
            plClear(uid);
            lib.playlists.forEach((p, i) => insertPlaylist(uid, p, i));

            // Play counts: the higher count and the later play win, so importing the same backup twice changes
            // nothing. A backup only has totals: what it has beyond ours comes in as one row, dated at its last play.
            if (mode === "replace") playsClear(uid);
            // Backwards, so that plays at the same moment keep the backup's order (see RECENT).
            for (const p of [...incoming.plays].reverse()) {
              const have = playsOf(uid, p.track.id)!;
              if (!Number(have.rows)) result.playsAdded++;
              upsertTrack(p.track);
              const extra = Math.max(0, p.count - Number(have.n));
              if (extra || p.lastPlayed > Number(have.last)) playInsert(uid, p.track.id, p.lastPlayed, extra, "import");
            }
            return result;
          });
        },

        recent: () => tx(() => recentList(uid)),

        pushRecent: (item) =>
          tx(() => {
            const at = Date.now();
            recentDelete(uid, item.kind, item.id);
            recentInsert(uid, item.kind, item.id, JSON.stringify({ ...item, at }), at);
            recentTrim(uid, uid, RECENT_LIMIT);
            return recentList(uid);
          }),

        removeRecent: (kind, id) =>
          tx(() => {
            recentDelete(uid, kind, id);
            return recentList(uid);
          }),

        clearRecent: () =>
          tx(() => {
            recentClear(uid);
            return recentList(uid);
          }),
      };
    },
  };
}
