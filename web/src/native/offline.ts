import type { LibraryStore } from "../../../server/src/library";
import * as library from "../../../server/src/library";
import { getT } from "../i18n";
import { ApiError, type AuthStatus, type MusikeApi, type ServerLink } from "../lib/apiTypes";
import { toast } from "../stores/ui";
import { nativeFetch } from "./http";
import { fileStorage } from "./storage";

// Connected to a Musike server, the app keeps going when the server can't be reached (no network, the VPN down,
// the server restarting). It plays and searches from the phone itself, like the standalone app, with a copy of the
// account's library from the last time the server answered. What changes meanwhile (plays, favorites, saved
// artists and albums, playlists, the Recent list) is applied to that copy and queued; the server is tried again
// every so often, and when it answers the queue is sent, in order, and the copy refreshed. Nothing to switch in
// Settings: the app stays connected to the server and comes back on its own.

/**
 * Just gone (at start, or a drop on the way): the server is tried again a few times in quick succession, since a
 * VPN coming up or a change of network is often over in seconds; then this often (and whenever the network comes
 * back, or the app comes back to the front).
 */
const QUICK_TRIES = 5;
const QUICK_MS = 2000;
const RETRY_MS = 20_000;
/** A server that doesn't answer within this long counts as out of reach (a page from YouTube can take a while). */
const TIMEOUT_MS = 20_000;
/** A request taking longer than this: the server's health is checked, so a network that hangs doesn't hold the app. */
const SLOW_MS = 4000;
const HEALTH_TIMEOUT_MS = 3000;
/** For the first question at start (the sign-in state): the app waits for it. */
const START_TIMEOUT_MS = 5000;
/** The copy is refreshed at most this often while connected (and after the queue is sent). */
const SNAPSHOT_MS = 10 * 60_000;
const MAX_QUEUED = 2000;

const AUTH_KEY = "musike:offline-auth";
const QUEUE_KEY = "musike:offline-queue";
const OWNER_KEY = "musike:offline-owner";

/** A change made without the server, to send when it's back. `tries`: times the server failed on it (5xx). */
type Change = { method: Writes; args: unknown[]; localId?: string; tries?: number };

/** A change the server keeps failing on (an error of its own, 5xx) is dropped after this many tries, not to hold the rest back forever. */
const MAX_TRIES = 8;

const WRITES = [
  "addFavorite",
  "addFavorites",
  "removeFavorite",
  "pushHistory",
  "saveArtist",
  "removeArtist",
  "saveAlbum",
  "removeAlbum",
  "saveYtPlaylist",
  "removeYtPlaylist",
  "createPlaylist",
  "renamePlaylist",
  "deletePlaylist",
  "addToPlaylist",
  "removeFromPlaylist",
  "reorderPlaylist",
  "createRadioPlaylist",
  "updateRadioPlaylist",
  "saveRadioPlaylist",
  "pushRecent",
  "removeRecent",
  "clearRecent",
  "removeFromHistory",
  "forget",
  "setProfileSettings",
] as const;
type Writes = (typeof WRITES)[number];

const CATALOG = [
  "search",
  "suggest",
  "radio",
  "genres",
  "genre",
  "genreArtists",
  "artist",
  "album",
  "searchAlbums",
  "searchArtists",
  "searchPlaylists",
  "ytPlaylist",
  "videoFor",
  "system",
  "topPlays",
  "discover",
  "profileImage",
  "playLog",
  "profileSettings",
] as const;

/** Changes that name a playlist by its id (first argument): one created offline gets the server's id. */
const ON_PLAYLIST = new Set<string>([
  "renamePlaylist",
  "deletePlaylist",
  "addToPlaylist",
  "removeFromPlaylist",
  "reorderPlaylist",
  "updateRadioPlaylist",
  "saveRadioPlaylist",
]);
/** Changes that make a playlist: offline it has the copy's id until the server gives its own. */
const MAKES_PLAYLIST = new Set<string>(["createPlaylist", "createRadioPlaylist"]);

/** The server didn't answer (as opposed to answering "no"): no network, refused, timed out, or a proxy's 502-504. */
export function unreachable(e: unknown): boolean {
  if (e instanceof ApiError) {
    // Not Musike's answer: the reverse proxy's 404 while the container restarts, a captive portal...
    if (!e.fromServer) return true;
    return e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504;
  }
  return (e as Error)?.name !== "AbortError";
}

/** The server's own trouble, worth trying again later rather than dropping the change: an error, too many requests. */
const passing = (e: unknown) => e instanceof ApiError && (e.status >= 500 || e.status === 429 || e.status === 408);

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new ApiError(0, "timeout")), ms))]);
}

const readJson = <T>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};

interface Options {
  url: string;
  server: MusikeApi;
  /** The phone's own engine, over a library: the copy of the account's. */
  phone: (lib: LibraryStore) => MusikeApi;
}

export function offlineCapable({ url, server, phone }: Options) {
  const t = () => getT().offline;
  const copyStorage = fileStorage("server-copy.json");
  // The copy, swapped for a fresh one whenever it is rewritten from the server.
  let copy = library.jsonLibrary(copyStorage);
  const store = new Proxy({} as LibraryStore, { get: (_, key) => copy[key as keyof LibraryStore] });
  const local = phone(store);

  let online = true;
  let since: number | null = null;
  /** Tries since the server went away, and whether that has been said (only after the quick tries). */
  let tries = 0;
  let told = false;
  let retryTimer = 0;
  let lastSnapshot = 0;
  let snapshotTimer = 0;
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((fn) => fn());

  // ---- The queue -----------------------------------------------------------------------------------------------

  const queued = (): Change[] => readJson<Change[]>(QUEUE_KEY, []);
  const keep = (changes: Change[]) => {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(changes.slice(-MAX_QUEUED)));
    } catch {
      /* full: the oldest go first next time */
    }
    changed();
  };
  const enqueue = (c: Change) => keep([...queued(), c]);

  /** Sends the queue in order; stops (keeping the rest) if the server goes away again. Returns how many went. */
  /** `stuck`: the server is there but failed on a change (an error of its own): sent again a little later. */
  type Flushed = { sent: number; done: boolean; signedOut?: boolean; stuck?: boolean };
  let flushing: Promise<Flushed> | null = null;
  /** Sends the queue in order (one flush at a time); done once it's empty, not when the server went away midway. */
  function flush() {
    return (flushing ??= sendQueue().finally(() => (flushing = null)));
  }

  async function sendQueue(): Promise<Flushed> {
    let sent = 0;
    for (;;) {
      const next = queued()[0];
      if (!next) return { sent, done: true };
      let created: string | null = null;
      try {
        const send = server[next.method] as (...a: unknown[]) => Promise<unknown>;
        const result = await within(send(...next.args), TIMEOUT_MS);
        if (MAKES_PLAYLIST.has(next.method)) created = (result as { id: string }).id;
        sent++;
      } catch (e) {
        // Still gone: the rest waits.
        if (unreachable(e)) return { sent, done: false };
        // Signed out meanwhile (the session ran out): kept until signed in again, not dropped.
        if (e instanceof ApiError && e.status === 401) return { sent, done: false, signedOut: true };
        // The server in trouble (an error of its own, too busy): this one and the rest wait for the next try. A
        // change it fails on every time is dropped in the end, not to hold the others back forever.
        if (passing(e) && (next.tries ?? 0) + 1 < MAX_TRIES) {
          keep([{ ...next, tries: (next.tries ?? 0) + 1 }, ...queued().slice(1)]);
          return { sent, done: false, stuck: true };
        }
        // Refused (a playlist deleted meanwhile on another device...): dropped, the rest goes on.
      }
      // Read again: more may have been queued while this one went. A playlist made offline now has the server's
      // id: the changes after it name that one.
      const rest = queued().slice(1);
      const from = next.localId;
      keep(
        created && from
          ? rest.map((c) => (ON_PLAYLIST.has(c.method) && c.args[0] === from ? { ...c, args: [created, ...c.args.slice(1)] } : c))
          : rest,
      );
    }
  }

  // ---- The copy ------------------------------------------------------------------------------------------------

  /** Rewrites the copy from the server (never over changes still waiting to be sent). */
  async function snapshot() {
    if (queued().length || !online) return;
    try {
      const [lib, plays, recent] = await Promise.all([
        within(server.library(), TIMEOUT_MS),
        within(server.plays(), TIMEOUT_MS),
        within(server.recent(), TIMEOUT_MS),
      ]);
      const { plays: _none, ...rest } = lib as typeof lib & { plays?: unknown };
      // The most recently played, as many as the copy keeps (the server keeps them all).
      const kept = [...plays].sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, library.PLAYS_LIMIT);
      await copyStorage.write(JSON.stringify({ ...rest, plays: kept, recent }));
      copy = library.jsonLibrary(copyStorage);
      lastSnapshot = Date.now();
    } catch (e) {
      if (unreachable(e)) wentAway();
    }
  }

  const snapshotSoon = () => {
    if (Date.now() - lastSnapshot < SNAPSHOT_MS && lastSnapshot) return;
    window.clearTimeout(snapshotTimer);
    snapshotTimer = window.setTimeout(() => void snapshot(), 3000);
  };

  /** Another account (or none) on this phone than the copy's: the copy and its queue aren't theirs. */
  function owner(status: AuthStatus) {
    const who = status.enabled ? String(status.user?.id ?? "") : "open";
    if (!who) return;
    if (localStorage.getItem(OWNER_KEY) !== who) {
      localStorage.setItem(OWNER_KEY, who);
      localStorage.removeItem(QUEUE_KEY);
      void copyStorage.remove().then(() => (copy = library.jsonLibrary(copyStorage)));
      lastSnapshot = 0;
    }
  }

  // ---- Reaching the server -------------------------------------------------------------------------------------

  let checking: Promise<boolean> | null = null;
  /** Does the server answer? (One check at a time, shared by whoever asks meanwhile.) */
  function healthy(): Promise<boolean> {
    return (checking ??= (async () => {
      try {
        const res = await within(nativeFetch(`${url}/api/health`, { headers: { "user-agent": "Musike Android" } }), HEALTH_TIMEOUT_MS);
        const body = res.ok ? ((await res.json().catch(() => null)) as { ok?: unknown } | null) : null;
        return body?.ok === true;
      } catch {
        return false;
      }
    })().finally(() => (checking = null)));
  }

  /**
   * A request that takes long: if the server doesn't answer its health check either, it counts as out of reach
   * now, instead of after the whole timeout (a network that hangs rather than fails, like a VPN going down).
   */
  async function watched<T>(p: Promise<T>): Promise<T> {
    let done = false;
    p.then(
      () => (done = true),
      () => (done = true),
    );
    await Promise.race([p.then(() => {}, () => {}), new Promise((r) => setTimeout(r, SLOW_MS))]);
    if (!done && !(await healthy())) throw new ApiError(0, "unreachable");
    return p;
  }

  /** The server is gone: the app goes on from the phone at once, and says so if the quick tries don't bring it back. */
  let flushTimer = 0;
  /** With the server there: what's queued (a play it failed on just now, a change it was too busy for) goes a little later. */
  function flushLater() {
    window.clearTimeout(flushTimer);
    flushTimer = window.setTimeout(() => {
      if (!online || !queued().length) return;
      void flush().then((r) => {
        if (r.stuck) flushLater();
        else if (!r.done && !r.signedOut) wentAway();
      });
    }, RETRY_MS);
  }

  function wentAway() {
    if (!online) return;
    online = false;
    since = Date.now();
    tries = 0;
    told = false;
    schedule();
    changed();
  }

  function schedule() {
    window.clearTimeout(retryTimer);
    if (!online) retryTimer = window.setTimeout(() => void retry(), tries < QUICK_TRIES ? QUICK_MS : RETRY_MS);
  }

  /** A try that found no server: after the quick ones, it's said. */
  function stillGone() {
    tries++;
    if (tries >= QUICK_TRIES && !told) {
      told = true;
      toast(t().gone);
    }
    schedule();
    changed();
  }

  let trying: Promise<boolean> | null = null;
  /** Tries the server; back: the queue goes, the copy is refreshed, the app reloads what it shows. */
  /** Asked by a button: the result is said, back or not. */
  let manualTry = false;

  function retry(manual = false): Promise<boolean> {
    if (online) return Promise.resolve(true);
    if (manual) manualTry = true;
    trying ??= (async () => {
      const ok = await healthy();
      if (!ok) {
        stillGone();
        return false;
      }
      // The queue goes first, while the app still writes behind it: the server gets the changes in order.
      const waiting = queued().length;
      const { sent, done, signedOut, stuck } = await flush();
      if (stuck) {
        // The server is there and failing on one change: back online, the queue goes again in a while.
        online = true;
        since = null;
        flushLater();
        changed();
        return true;
      }
      if (signedOut) {
        // The server is there, the session isn't: the app asks to sign in, then the rest goes (authStatus).
        online = true;
        since = null;
        changed();
        return true;
      }
      if (!done) {
        // Gone again midway: what's left waits for the next try.
        stillGone();
        return false;
      }
      online = true;
      since = null;
      // A change that was being written to the copy just now.
      if (queued().length) void flush().then((r) => (r.stuck ? flushLater() : r.done || r.signedOut || wentAway()));
      // Back within the quick tries, with nothing sent: nothing to say (nothing was said either).
      if (waiting) toast(t().backSent(sent));
      else if (told || manualTry) toast(t().back);
      manualTry = false;
      lastSnapshot = 0;
      void snapshot();
      changed();
      return true;
    })().finally(() => (trying = null));
    return trying;
  }

  // Back online, or back to the app (the phone may have changed network meanwhile): try now.
  addEventListener("online", () => void retry());
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void retry());

  // ---- The API ---------------------------------------------------------------------------------------------------

  /** Ask the server; out of reach, ask the phone instead (and note that the server is gone). */
  function either<A extends unknown[], R>(ask: (...a: A) => Promise<R>, instead: (...a: A) => Promise<R>, ms = TIMEOUT_MS) {
    return async (...a: A): Promise<R> => {
      if (online) {
        try {
          return await within(watched(ask(...a)), ms);
        } catch (e) {
          if (!unreachable(e)) throw e;
          wentAway();
        }
      }
      return instead(...a);
    };
  }

  const api: MusikeApi = { ...server };
  const bind = <K extends keyof MusikeApi>(k: K) => (server[k] as (...a: unknown[]) => Promise<unknown>).bind(server);

  for (const k of CATALOG) {
    (api as unknown as Record<string, unknown>)[k] = either(bind(k), (local[k] as (...a: unknown[]) => Promise<unknown>).bind(local));
  }

  // Reads: the server's, which also refresh the copy now and then; offline, the copy's.
  api.library = either(
    async () => {
      const lib = await server.library();
      snapshotSoon();
      return lib;
    },
    () => local.library(),
  );
  api.plays = either(server.plays.bind(server), local.plays.bind(local));
  api.recent = either(server.recent.bind(server), local.recent.bind(local));

  // Changes: to the server; offline, to the copy, and queued.
  for (const k of WRITES) {
    const viaServer = bind(k);
    const viaCopy = (local[k] as (...a: unknown[]) => Promise<unknown>).bind(local);
    const offline = async (...asked: unknown[]) => {
      // A play keeps the time it was made: the server logs it then, not when it's sent.
      const args = k === "pushHistory" && asked[1] === undefined ? [asked[0], Date.now()] : asked;
      const result = await viaCopy(...args);
      enqueue({ method: k, args, localId: MAKES_PLAYLIST.has(k) ? (result as { id: string }).id : undefined });
      return result;
    };
    const send = either(viaServer, offline);
    (api as unknown as Record<string, unknown>)[k] =
      k === "pushHistory"
        ? // A play is never lost: whatever goes wrong on the server's side (the session ran out, an error), it's kept
          // and sent again later. Only a track the server can't take at all (400) is let go.
          async (track: unknown, at: unknown = Date.now()) => {
            try {
              return await send(track, at);
            } catch (e) {
              if (e instanceof ApiError && e.status === 400) throw e;
              const kept = await offline(track, at);
              if (online) flushLater();
              return kept;
            }
          }
        : send;
  }

  // Signed in or not: offline, as the server said last time.
  api.authStatus = either(
    async () => {
      const s = await server.authStatus();
      try {
        localStorage.setItem(AUTH_KEY, JSON.stringify(s));
      } catch {
        /* not critical */
      }
      owner(s);
      // Signed in again with changes still waiting (the session had run out while they were sent).
      if (s.user && online && queued().length) void flush();
      return s;
    },
    async () => readJson<AuthStatus>(AUTH_KEY, { enabled: false, setup: false, user: null }),
    START_TIMEOUT_MS,
  );

  // Signing out: what was kept for this account goes.
  api.logout = async () => {
    await server.logout();
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem(QUEUE_KEY);
    localStorage.removeItem(OWNER_KEY);
    await copyStorage.remove();
  };

  // Everything else (accounts, imports, yt-dlp) needs the server: offline it says so.
  const needsServer = ["setup", "login", "changePassword", "users", "createUser", "setUserRole", "resetUserPassword", "deleteUser", "importLibrary", "updateYtdlp", "setProfileImage"] as const;
  for (const k of needsServer) {
    const ask = bind(k);
    (api as unknown as Record<string, unknown>)[k] = async (...a: unknown[]) => {
      if (!online && !(await retry())) throw new ApiError(0, t().needsServer);
      return ask(...a);
    };
  }

  /** For a stream that failed or stalled: is the server still there? (If not, the app goes on from the phone.) */
  async function check(): Promise<boolean> {
    if (!online) return false;
    if (await healthy()) return true;
    wentAway();
    return false;
  }

  /** Which track last got a stream: asked again soon after, it failed (a retry), so the server is checked first. */
  let lastStream: { id: string; at: number } | null = null;

  return {
    api,
    /**
     * A stream: the server's, or the phone's own while the server is out of reach. Asked again for the same track
     * soon after (the player retrying a stream that failed or stalled), the server is checked first.
     */
    async streamSource(id: string, viaServer: () => Promise<string>, viaPhone: () => Promise<string>): Promise<string> {
      const again = lastStream?.id === id && Date.now() - lastStream.at < 60_000;
      lastStream = { id, at: Date.now() };
      if (online && again && !(await healthy())) wentAway();
      if (online) {
        try {
          return await within(watched(viaServer()), TIMEOUT_MS);
        } catch (e) {
          if (!unreachable(e)) throw e;
          wentAway();
        }
      }
      return viaPhone();
    },
    online: () => online,
    check,
    link: {
      get online() {
        return online;
      },
      get since() {
        return since;
      },
      get pending() {
        return queued().length;
      },
      subscribe(fn: () => void) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      retry,
      check,
    } satisfies ServerLink,
  };
}
