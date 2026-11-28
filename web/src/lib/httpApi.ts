import { getLang, getT } from "../i18n";
import { deviceId } from "./device";
import {
  ApiError,
  authEvents,
  type AuthStatus,
  type AuthUser,
  type Channel,
  type ErrorCode,
  type ImportResult,
  type Lyrics,
  type MusikeApi,
  type PlayLog,
  type Prepared,
  type SystemInfo,
  type SystemJob,
  type TopRange,
  type UserInfo,
} from "./apiTypes";
import type {
  AlbumCard,
  AlbumPage,
  ArtistCard,
  ArtistPage,
  Discover,
  Genre,
  GenreArtist,
  GenrePage,
  Library,
  PlayEntry,
  Playlist,
  PlaylistCard,
  RadioPatch,
  RecentInput,
  RecentItem,
  RecentKind,
  SavedAlbum,
  SavedArtist,
  SavedYtPlaylist,
  Track,
  YtPlaylistPage,
} from "./types";

/**
 * The Musike server over HTTP, as a backend for the app: the web and desktop apps talk to the server they were
 * loaded from (lib/api.ts), the Android app to the server it is connected to (native/api.ts, in server mode).
 */

/** The server answers errors (and YouTube Music answers names, like genres) in the app's language. */
const LANG_HEADER = "x-musike-lang";

export interface HttpBackendOptions {
  /** "" for the server the page came from; otherwise the server's address, e.g. "http://192.168.1.10:4180". */
  base: string;
  fetch: typeof fetch;
  /** Apps: the session token they send as "Authorization: Bearer" (web pages use the cookie instead). */
  token?: { get(): string | null; set(token: string | null): void };
  /** Sent with every request (e.g. the app's own User-Agent). */
  headers?: Record<string, string>;
}

export function httpBackend(opts: HttpBackendOptions) {
  async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
    const { json: given, ...rest } = init ?? {};
    // Android's HTTP stack labels a request without a body as a form, which the server refuses: requests that
    // change something always carry JSON, an empty object when there's nothing to send.
    const method = (rest.method ?? "GET").toUpperCase();
    const json = given !== undefined ? given : method !== "GET" && method !== "HEAD" && rest.body == null ? {} : undefined;
    const token = opts.token?.get();
    const res = await opts.fetch(opts.base + path, {
      ...rest,
      headers: {
        ...opts.headers,
        [LANG_HEADER]: getLang(),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
        // Changes say which device made them: the server tells the account's other devices (sync).
        ...(method !== "GET" && method !== "HEAD" ? { "x-musike-device": deviceId() } : {}),
        ...(rest.headers as Record<string, string> | undefined),
      },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
    if (res.status === 204) return undefined as T;
    const body = await res.json().catch((e) => {
      // Cancelled while the answer was arriving: the caller gave up, it must not get an empty answer instead.
      if (rest.signal?.aborted) throw e;
      return {};
    });
    if (!res.ok) {
      if (body.code === "auth_required" || body.code === "password_change_required") authEvents.listener?.(body.code);
      throw new ApiError(res.status, body.error ?? getT().player.httpError(res.status), body.code, typeof body.error === "string");
    }
    return body as T;
  }

  /** Apps ask for a token instead of a cookie, and keep it. */
  async function login(username: string, password: string): Promise<{ user: AuthUser }> {
    const r = await request<{ user: AuthUser; token?: string }>("/api/auth/login", {
      method: "POST",
      json: opts.token ? { username, password, client: "app" } : { username, password },
    });
    if (opts.token && r.token) opts.token.set(r.token);
    return { user: r.user };
  }

  const api: MusikeApi = {
    search: (q: string, type: "song" | "video", signal?: AbortSignal) =>
      request<{ tracks: Track[] }>(`/api/search?q=${encodeURIComponent(q)}&type=${type}`, { signal }).then((r) => r.tracks),
    suggest: (q: string, signal?: AbortSignal) =>
      request<{ suggestions: string[] }>(`/api/suggest?q=${encodeURIComponent(q)}`, { signal }).then((r) => r.suggestions),
    radio: (id: string) => request<{ tracks: Track[] }>(`/api/radio/${id}`).then((r) => r.tracks),
    genres: () => request<{ genres: Genre[] }>("/api/genres").then((r) => r.genres),
    genre: (id: string, signal?: AbortSignal) => request<GenrePage>(`/api/genres/${encodeURIComponent(id)}`, { signal }),
    genreArtists: (id: string, offset: number) =>
      request<{ artists: GenreArtist[]; hasMore: boolean }>(`/api/genres/${encodeURIComponent(id)}/artists?offset=${offset}`),
    artist: (id: string, signal?: AbortSignal) => request<ArtistPage>(`/api/artists/${encodeURIComponent(id)}`, { signal }),
    album: (id: string, signal?: AbortSignal) => request<AlbumPage>(`/api/albums/${encodeURIComponent(id)}`, { signal }),
    searchAlbums: (q: string, signal?: AbortSignal) =>
      request<{ albums: AlbumCard[] }>(`/api/search/albums?q=${encodeURIComponent(q)}`, { signal }).then((r) => r.albums),
    searchPlaylists: (q: string, signal?: AbortSignal) =>
      request<{ playlists: PlaylistCard[] }>(`/api/search/playlists?q=${encodeURIComponent(q)}`, { signal }).then((r) => r.playlists),
    ytPlaylist: (id: string, signal?: AbortSignal) => request<YtPlaylistPage>(`/api/yt-playlists/${encodeURIComponent(id)}`, { signal }),
    searchArtists: (q: string, signal?: AbortSignal) =>
      request<{ artists: ArtistCard[] }>(`/api/search/artists?q=${encodeURIComponent(q)}`, { signal }).then((r) => r.artists),
    /** The music video matching a song, or null when YouTube has none. */
    videoFor: (t: Track) =>
      request<{ track: Track | null }>(
        `/api/video-for/${t.id}?${new URLSearchParams({ title: t.title, artist: t.artist, duration: String(t.duration || "") })}`,
      ).then((r) => r.track),
    lyrics: (t: Track, signal?: AbortSignal) =>
      request<{ lyrics: Lyrics | null }>(
        `/api/lyrics/${t.id}?${new URLSearchParams({
          title: t.title,
          artist: t.artist,
          album: t.album ?? "",
          duration: String(t.duration || ""),
        })}`,
        { signal },
      ).then((r) => r.lyrics),
    prepare: (id: string, signal?: AbortSignal) =>
      request<Prepared>(`/api/prepare/${id}`, {
        method: "POST",
        signal,
      }),
    loudness: (id: string) => request<{ loudnessDb: number | null }>(`/api/loudness/${id}`).then((r) => r.loudnessDb),
    videoQualities: (id: string) => request<{ qualities: number[]; max: number }>(`/api/video-qualities/${id}`),
    prepareVideo: (id: string, height: number, signal?: AbortSignal) =>
      request<{ ready: boolean; height?: number }>(`/api/prepare/${id}/video?h=${height}`, { method: "POST", signal }).then(
        (r) => r.height || height, // an older server doesn't say: the one asked for
      ),
    prefetchAudio: (id: string) => request<{ queued: boolean }>(`/api/prefetch/${id}/audio`, { method: "POST" }).then(() => undefined),

    library: () => request<Library>("/api/library"),
    addFavorite: (t: Track) => request<{ favorites: Track[] }>(`/api/favorites/${t.id}`, { method: "PUT", json: t }),
    addFavorites: (tracks: Track[]) => request<{ favorites: Track[] }>("/api/favorites", { method: "POST", json: { tracks } }),
    removeFavorite: (id: string) => request<{ favorites: Track[] }>(`/api/favorites/${id}`, { method: "DELETE" }),
    pushHistory: (t: Track, at?: number) =>
      request<{ history: Track[] }>(at ? `/api/history?at=${Math.round(at)}` : "/api/history", { method: "POST", json: t }),
    plays: (artistId?: string, name?: string, signal?: AbortSignal) =>
      request<{ plays: PlayEntry[] }>(
        artistId ? `/api/plays?artist=${artistId}&name=${encodeURIComponent(name ?? "")}` : "/api/plays",
        { signal },
      ).then((r) => r.plays),
    topPlays: (range: TopRange, limit = 5, signal?: AbortSignal) =>
      request<{ plays: PlayEntry[]; first: number | null }>(
        typeof range === "object"
          ? `/api/profile/top?since=${Math.round(range.since)}&limit=${limit}`
          : `/api/profile/top?range=${range}&limit=${limit}`,
        { signal },
      ),
    playLog: (since: number, until: number, signal?: AbortSignal) =>
      request<PlayLog>(`/api/profile/log?since=${Math.round(since)}&until=${Math.round(until)}`, { signal }),
    profileSettings: (signal?: AbortSignal) =>
      request<{ accent: string | null; profilePeriod: string | null }>("/api/profile/settings", { signal }),
    setProfileSettings: (patch: { accent?: string | null; profilePeriod?: string | null }) =>
      request<{ accent: string | null; profilePeriod: string | null }>("/api/profile/settings", { method: "PUT", json: patch }),
    profileImage: (signal?: AbortSignal) => request<{ image: string | null }>("/api/profile/image", { signal }).then((r) => r.image),
    setProfileImage: (image: string | null) =>
      request<{ image: string | null }>("/api/profile/image", { method: "PUT", json: { image } }).then((r) => r.image),
    removeFromHistory: (id: string) => request<{ history: Track[] }>(`/api/history/${id}`, { method: "DELETE" }),
    forget: (id: string) => request<{ history: Track[] }>(`/api/plays/${id}`, { method: "DELETE" }),
    discover: (signal?: AbortSignal) => request<Discover>("/api/profile/discover", { signal }),
    saveArtist: (a: SavedArtist) => request<{ artists: SavedArtist[] }>(`/api/library/artists/${a.id}`, { method: "PUT", json: a }),
    removeArtist: (id: string) => request<{ artists: SavedArtist[] }>(`/api/library/artists/${id}`, { method: "DELETE" }),
    saveAlbum: (a: SavedAlbum) => request<{ albums: SavedAlbum[] }>(`/api/library/albums/${a.id}`, { method: "PUT", json: a }),
    removeAlbum: (id: string) => request<{ albums: SavedAlbum[] }>(`/api/library/albums/${id}`, { method: "DELETE" }),
    saveYtPlaylist: (p: SavedYtPlaylist) =>
      request<{ ytPlaylists: SavedYtPlaylist[] }>(`/api/library/yt-playlists/${p.id}`, { method: "PUT", json: p }),
    removeYtPlaylist: (id: string) => request<{ ytPlaylists: SavedYtPlaylist[] }>(`/api/library/yt-playlists/${id}`, { method: "DELETE" }),
    createPlaylist: (name: string, tracks: Track[] = []) =>
      request<Playlist>("/api/playlists", { method: "POST", json: { name, tracks } }),
    renamePlaylist: (id: string, name: string) => request<Playlist>(`/api/playlists/${id}`, { method: "PATCH", json: { name } }),
    deletePlaylist: (id: string) => request<void>(`/api/playlists/${id}`, { method: "DELETE" }),
    addToPlaylist: (id: string, t: Track | Track[]) =>
      request<Playlist>(`/api/playlists/${id}/tracks`, { method: "POST", json: Array.isArray(t) ? { tracks: t } : t }),
    removeFromPlaylist: (id: string, trackId: string) =>
      request<Playlist>(`/api/playlists/${id}/tracks/${trackId}`, { method: "DELETE" }),
    reorderPlaylist: (id: string, ids: string[]) => request<Playlist>(`/api/playlists/${id}/order`, { method: "PUT", json: { ids } }),
    createRadioPlaylist: (name: string, seed: string, tracks: Track[]) =>
      request<Playlist>("/api/playlists/radio", { method: "POST", json: { name, seed, tracks } }),
    updateRadioPlaylist: (id: string, patch: RadioPatch) => request<Playlist>(`/api/playlists/${id}/radio`, { method: "PATCH", json: patch }),
    saveRadioPlaylist: (id: string) => request<Playlist>(`/api/playlists/${id}/save`, { method: "POST" }),

    recent: (signal?: AbortSignal) => request<{ recent: RecentItem[] }>("/api/recent", { signal }).then((r) => r.recent),
    pushRecent: (item: RecentInput) => request<{ recent: RecentItem[] }>("/api/recent", { method: "POST", json: item }).then((r) => r.recent),
    removeRecent: (kind: RecentKind, id: string) =>
      request<{ recent: RecentItem[] }>(`/api/recent/${kind}/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => r.recent),
    clearRecent: () => request<{ recent: RecentItem[] }>("/api/recent", { method: "DELETE" }).then((r) => r.recent),

    importLibrary: (backup: unknown, mode: "merge" | "replace") =>
      request<ImportResult>("/api/library/import", { method: "POST", json: { backup, mode } }),

    system: () => request<SystemInfo>("/api/system"),
    updateYtdlp: (channel: Channel) => request<SystemJob>("/api/system/ytdlp", { method: "POST", json: { channel } }),

    // An older server has no accounts: its 404 means "off".
    authStatus: () =>
      request<AuthStatus>("/api/auth/status").catch((e) => {
        if (e instanceof ApiError && e.status === 404) return { enabled: false, setup: false, user: null };
        throw e;
      }),
    setup: async (username: string, password: string, code: string) => {
      const r = await request<{ user: AuthUser }>("/api/auth/setup", { method: "POST", json: { username, password, code } });
      // The setup answers with a cookie; an app signs in again for its token.
      if (opts.token) await login(username, password);
      return r;
    },
    login,
    logout: async () => {
      try {
        await request<void>("/api/auth/logout", { method: "POST" });
      } finally {
        opts.token?.set(null);
      }
    },
    changePassword: (current: string, password: string) =>
      request<{ user: AuthUser }>("/api/auth/password", { method: "POST", json: { current, password } }),
    users: () => request<{ users: UserInfo[] }>("/api/users").then((r) => r.users),
    createUser: (username: string, role: "admin" | "user") =>
      request<{ user: AuthUser; password: string }>("/api/users", { method: "POST", json: { username, role } }),
    setUserRole: (id: number, role: "admin" | "user") => request<{ user: AuthUser }>(`/api/users/${id}`, { method: "PATCH", json: { role } }),
    resetUserPassword: (id: number) => request<{ password: string }>(`/api/users/${id}/password`, { method: "POST" }),
    deleteUser: (id: number) => request<void>(`/api/users/${id}`, { method: "DELETE" }),

  };

  /** The server's stream proxy for a track. */
  /** `height`: the video's quality line (360 is the ready-made SD stream). */
  const streamPath = (id: string, kind: "audio" | "video", height: number) =>
    kind === "audio" ? `/api/stream/${id}/audio` : `/api/stream/${id}/video?h=${height}`;

  /** Media elements hide the HTTP error body; fetch it to show the real reason. */
  async function explain(url: string): Promise<{ message: string; code?: ErrorCode }> {
    const t = getT();
    try {
      const res = await opts.fetch(url, { headers: { ...opts.headers, Range: "bytes=0-0", [LANG_HEADER]: getLang() } });
      if (res.ok) return { message: t.player.browserCantPlay };
      const body = await res.json().catch(() => ({}));
      if (body.code === "auth_required" || body.code === "password_change_required") authEvents.listener?.(body.code);
      return { message: body.error ?? t.player.httpError(res.status), code: body.code };
    } catch {
      return { message: t.player.serverDown };
    }
  }

  return { api, request, streamPath, explain };
}
