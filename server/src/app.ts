import fs, { existsSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:net";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import {
  accounts,
  checkPassword,
  checkUsername,
  loginThrottle,
  type PublicUser,
  type Role,
  sameSetupCode,
  SESSION_DAYS,
  setupCode,
} from "./auth.js";
import {
  ALBUM_ID,
  album,
  ARTIST_ID,
  artist,
  GENRE_ID,
  genre,
  genreArtists,
  genres,
  home,
  moods,
  weeklyMix,
  searchAlbums,
  searchArtists,
  searchPlaylists,
  ytPlaylist,
  YT_PLAYLIST_ID,
} from "./browse.js";
import { config } from "./config.js";
import { DEFAULT_USER } from "./db.js";
import * as library from "./library.js";
import { discover, type Discover } from "./profile.js";
import { findVideoFor, radio, search, suggestions } from "./search.js";
import { passwordGate, sameOriginWrites, securityHeaders } from "./security.js";
import { keepBackups } from "./backups.js";
import { openServerLibrary } from "./storage.js";
import { proxyStream, serveFile } from "./stream.js";
import { syncHub, type LibraryPart } from "./sync.js";
import { langOf, msg, tr } from "./i18n.js";
import { lyricsFor } from "./lyrics.js";
import { keepChannel, presentJob, startJob, systemInfo, type Channel } from "./system.js";
import { refreshTools, type Tools } from "./tools.js";
import { HttpError, VIDEO_ID } from "./types.js";
import { cacheAudio, cachedAudio } from "./audioCache.js";
import { downloadVideo, heightOfFile, loudnessOf, pruneCache, resolveStreams, videoQualities } from "./ytdlp.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Who is signed in (accounts on), or null. */
    user: PublicUser | null;
    sessionId: string | null;
  }
}

const COOKIE = "musike_session";

function readCookie(header: string | undefined, name: string): string {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return "";
      }
    }
  }
  return "";
}

/** The session token: "Authorization: Bearer" (apps), or the cookie (the web app). */
function tokenOf(req: FastifyRequest): string {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  return readCookie(req.headers.cookie, COOKIE);
}

/** HttpOnly: page scripts can't read it. SameSite=Lax: other sites can't send it with their requests. */
const sessionCookie = (token: string, secure: boolean, maxAge: number) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

/** Routes that work signed out (health: Docker's check), and the ones left while a new password is due. */
const OPEN = new Set(["/api/health", "/api/auth/status", "/api/auth/login", "/api/auth/setup", "/api/auth/logout"]);
const WHILE_PASSWORD_DUE = new Set(["/api/auth/status", "/api/auth/password", "/api/auth/logout"]);

function videoId(params: unknown): string {
  const id = (params as { id?: string }).id ?? "";
  if (!VIDEO_ID.test(id)) throw new HttpError(400, msg("invalidVideoId"));
  return id;
}

/** The video quality asked for: ?h= (lines, e.g. 720), or the older ?q=hd (720); 0 for the ready-made SD stream. */
function heightOf(q: unknown): number {
  const { h, q: legacy } = (q ?? {}) as { h?: string; q?: string };
  const height = Math.trunc(Number(h));
  if (Number.isFinite(height) && height >= 144 && height <= 4320) return height;
  return legacy === "hd" ? 720 : 0;
}

/** Aborted when the client goes away before its answer is sent. */
function gone(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) controller.abort(new Error("the client went away"));
  });
  return controller.signal;
}

function query(q: unknown): string {
  const s = typeof q === "string" ? q.trim() : "";
  if (!s) throw new HttpError(400, msg("emptyQuery"));
  return s.slice(0, 200);
}

export interface StartOptions {
  port?: number;
  host?: string;
  /** Try the next ports when the preferred one is taken (the desktop app does this). */
  portFallback?: boolean;
}

export interface RunningServer {
  port: number;
  tools: Tools;
  /** Accounts: off, on, or on and waiting for the first admin to set a password. */
  accounts: "off" | "on" | "setup";
  /** Where the library lives: data/musike.db, or data/library.json. */
  library: "sqlite" | "json";
  /** While accounts wait for the admin: the code to print, asked when the admin is created. */
  setupCode: string | null;
  close: () => Promise<void>;
}

/** Builds the Musike HTTP server (API + web app) and starts listening. */

interface AccountSettings {
  accent: string | null;
  profilePeriod: string | null;
}

const PROFILE_PERIODS = new Set(["7d", "1m", "3m", "12m", "all"]);

/** Only what's known, well formed: a #rrggbb colour, one of the profile's periods. */
function cleanSettings(v: Record<string, unknown>): AccountSettings {
  return {
    accent: typeof v.accent === "string" && /^#[0-9a-f]{6}$/i.test(v.accent) ? v.accent.toLowerCase() : null,
    profilePeriod: typeof v.profilePeriod === "string" && PROFILE_PERIODS.has(v.profilePeriod) ? v.profilePeriod : null,
  };
}

/** The profile's "most played lately". */
const PROFILE_RANGE_MS = 91 * 24 * 3600_000;
/** How long the profile's suggestions are kept before they're worked out again. */
const DISCOVER_MS = 24 * 3600_000;

/** The device a request comes from (sync.ts's id for it), as the web app says in a header. */
function deviceOf(req: FastifyRequest): string | undefined {
  const v = req.headers["x-musike-device"];
  return typeof v === "string" && /^[\w-]{1,64}$/.test(v) ? v : undefined;
}

/** Which part of the library a route that changes something changes (the history route says so itself). */
function libraryParts(route: string): LibraryPart[] {
  if (route === "/api/library/import") return ["library", "recent"];
  if (route.startsWith("/api/recent")) return ["recent"];
  if (route === "/api/history/:id") return ["library"];
  if (route === "/api/profile/settings") return ["settings"];
  if (route === "/api/plays/:id") return ["library", "recent"];
  if (/^\/api\/(favorites|playlists|library\/)/.test(route)) return ["library"];
  return [];
}

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const store = await openServerLibrary();
  if (config.auth && !store.db) {
    store.close();
    throw new Error("MUSIKE_AUTH=on needs the library in SQLite (Node 22.13 or later, and not MUSIKE_LIBRARY=json).");
  }
  const users = config.auth && store.db ? accounts(store.db) : null;
  users?.pruneSessions();
  const code = users?.needsSetup() ? setupCode() : null;
  /** Devices of one account playing in step (see sync.ts). */
  const sync = syncHub({ sessionAlive: users ? (id) => users.sessionAlive(id) : undefined });
  const throttle = loginThrottle();
  const checkingPassword = passwordGate();
  /** Each signed-in user's own library; the one library when accounts are off. */
  const libOf = (req: FastifyRequest) => (req.user ? store.forUser(req.user.id) : store.library);

  const found = await refreshTools();
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "warn" }, trustProxy: config.trustProxy });
  app.decorateRequest("user", null);
  app.decorateRequest("sessionId", null);
  securityHeaders(app, config.webDist);
  sameOriginWrites(app);

  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number };
    const status = e instanceof HttpError ? e.status : e.statusCode ?? 500;
    if (status >= 500) app.log.error(e);
    // Musike's own errors are translated into the language the app asked for.
    const error = e instanceof HttpError ? tr(langOf(req), e.text) : e.message;
    if (!reply.sent) reply.code(status).send({ error, code: e instanceof HttpError ? e.code : undefined });
  });

  // Accounts (MUSIKE_AUTH=on): every API route needs a session, except OPEN. The web app's files are public:
  // it shows the sign-in screen itself.
  if (users) {
    app.addHook("onRequest", async (req) => {
      const path = req.url.split("?")[0];
      if (!path.startsWith("/api/")) return;
      // Stream URLs carry their own token, signed for that track (apps' media elements can't send a header).
      const link = path.startsWith("/api/stream/") ? (req.query as { st?: unknown }).st : undefined;
      const s = typeof link === "string" ? users.streamSession(link, path.slice("/api/stream/".length)) : users.session(tokenOf(req));
      if (s) {
        req.user = s.user;
        req.sessionId = s.id;
      }
      if (OPEN.has(path)) return;
      if (!s) throw new HttpError(401, msg("notSignedIn"), "auth_required");
      if (s.user.mustChangePassword && !WHILE_PASSWORD_DUE.has(path)) {
        throw new HttpError(403, msg("passwordChangeRequired"), "password_change_required");
      }
    });
  }
  const enabled = () => {
    if (!users) throw new HttpError(404, msg("accountsOff"));
    return users;
  };
  const admin = (req: FastifyRequest): PublicUser => {
    enabled();
    if (req.user?.role !== "admin") throw new HttpError(403, msg("adminOnly"));
    return req.user;
  };
  const role = (v: unknown): Role => (v === "admin" ? "admin" : "user");
  const otherUser = (req: FastifyRequest): number => {
    const me = admin(req);
    const id = Number((req.params as { uid?: string }).uid);
    if (!Number.isInteger(id) || id < 1) throw new HttpError(404, msg("userNotFound"));
    if (id === me.id) throw new HttpError(400, msg("notYourself"));
    enabled().guardOwner(id);
    return id;
  };
  const signIn = (req: FastifyRequest, reply: FastifyReply, user: PublicUser, client: "web" | "app") => {
    const token = enabled().startSession(user.id, client, String(req.headers["user-agent"] ?? ""));
    if (client === "app") return { user, token };
    reply.header("set-cookie", sessionCookie(token, req.protocol === "https", SESSION_DAYS * 86_400));
    return { user };
  };

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/auth/status", async (req) =>
    users ? { enabled: true, setup: users.needsSetup(), user: req.user } : { enabled: false, setup: false, user: null },
  );

  /** First visit: the admin chooses a username and a password. Works once, while nobody has a password. */
  app.post("/api/auth/setup", async (req, reply) => {
    const accounts = enabled();
    // Checked before hashing anything: once set up, this costs nothing to ask.
    if (!accounts.needsSetup()) throw new HttpError(409, msg("setupDone"));
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown; code?: unknown };
    // The code from the server's log: guessing it is throttled like a password.
    const keys = [`setup:${req.ip}`];
    const wait = throttle.wait(keys);
    if (wait) throw new HttpError(429, msg("tooManyAttempts", { seconds: wait }));
    if (!code || !sameSetupCode(body.code, code)) {
      throttle.fail(keys);
      app.log.warn({ event: "setup_code_wrong", ip: req.ip }, "wrong setup code");
      throw new HttpError(403, msg("setupCodeWrong"));
    }
    throttle.succeed(keys);
    const username = checkUsername(body.username ?? "admin");
    const password = checkPassword(body.password);
    const user = await checkingPassword(() => accounts.setup(username, password));
    app.log.warn({ event: "setup", user: user.username, ip: req.ip }, "admin account set up");
    return signIn(req, reply, user, "web");
  });

  /** `client: "app"` returns the token (for "Authorization: Bearer") instead of setting the cookie. */
  app.post("/api/auth/login", async (req, reply) => {
    const accounts = enabled();
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown; client?: unknown };
    const name = typeof body.username === "string" ? body.username.trim().slice(0, 64) : "";
    const keys = [`user:${name.toLowerCase()}`, `ip:${req.ip}`];
    const wait = throttle.wait(keys);
    if (wait) throw new HttpError(429, msg("tooManyAttempts", { seconds: wait }));
    const password = body.password;
    // Counted as a failure before checking (a success clears it): many attempts sent at once can't all slip in
    // before the first one fails.
    throttle.fail(keys);
    const user = name && typeof password === "string" ? await checkingPassword(() => accounts.login(name, password)) : null;
    if (!user) {
      // One line per failure, with the address: what fail2ban and the like watch for.
      app.log.warn({ event: "login_failed", user: name, ip: req.ip }, "login failed");
      throw new HttpError(401, msg("wrongLogin"));
    }
    throttle.succeed(keys);
    return signIn(req, reply, user, body.client === "app" ? "app" : "web");
  });

  /** For apps: the key to sign stream URLs with (?st=, one track each), valid for hours, ended with the session. */
  app.post("/api/auth/stream-link", async (req) => enabled().streamLink(req.sessionId!));

  // A change to the library, from any device: the account's other devices are told, to fetch it again (sync.ts).
  // The history route tells them itself, with the new history.
  app.addHook("onResponse", async (req, reply) => {
    if (req.method === "GET" || req.method === "HEAD" || reply.statusCode >= 400) return;
    const parts = libraryParts(req.routeOptions.url ?? "");
    for (const part of parts) sync.changed(req.user?.id ?? DEFAULT_USER, part, deviceOf(req));
  });

  /** A single-use ticket to open the device connection with (WebSocket on /api/sync, see sync.ts). */
  app.post("/api/sync/ticket", async (req) => sync.ticket(req.user?.id ?? DEFAULT_USER, req.sessionId));
  // WebSocket connections skip Fastify's routes and hooks: the ticket is the check. Anything else is hung up on.
  app.server.on("upgrade", (req, socket, head) => {
    if (!sync.upgrade(req, socket, head)) socket.destroy();
  });

  app.post("/api/auth/logout", async (req, reply) => {
    if (req.sessionId) users?.endSession(req.sessionId);
    reply.header("set-cookie", sessionCookie("", req.protocol === "https", 0));
    return reply.code(204).send();
  });

  /** Changes your own password (needed after a temporary one) and signs out your other devices. */
  app.post("/api/auth/password", async (req) => {
    const accounts = enabled();
    const me = req.user!;
    const body = (req.body ?? {}) as { current?: unknown; password?: unknown };
    const keys = [`password:${me.id}`];
    const wait = throttle.wait(keys);
    if (wait) throw new HttpError(429, msg("tooManyAttempts", { seconds: wait }));
    const current = body.current;
    throttle.fail(keys);
    if (typeof current !== "string" || !(await checkingPassword(() => accounts.checkCurrent(me.id, current)))) {
      app.log.warn({ event: "password_change_failed", user: me.username, ip: req.ip }, "wrong current password");
      throw new HttpError(400, msg("wrongPassword"));
    }
    throttle.succeed(keys);
    const password = checkPassword(body.password);
    if (password === current) throw new HttpError(400, msg("samePassword"));
    const user = await checkingPassword(() => accounts.changePassword(me.id, password));
    accounts.endOtherSessions(me.id, req.sessionId!);
    return { user };
  });

  // Managing accounts: admins only, and never their own (no locking yourself out).

  app.get("/api/users", async (req) => {
    admin(req);
    return { users: enabled().list() };
  });

  /** A new account and its temporary password, shown once: the user changes it at the first sign-in. */
  app.post("/api/users", async (req) => {
    admin(req);
    const body = (req.body ?? {}) as { username?: unknown; role?: unknown };
    return enabled().create(checkUsername(body.username), role(body.role));
  });

  app.patch("/api/users/:uid", async (req) => {
    const id = otherUser(req);
    return { user: enabled().setRole(id, role((req.body as { role?: unknown } | null)?.role)) };
  });

  /** Forgotten password: a new temporary one, and the user's devices are signed out. */
  app.post("/api/users/:uid/password", async (req) => ({ password: await enabled().reset(otherUser(req)) }));

  /** Deletes the account and its library. */
  app.delete("/api/users/:uid", async (req, reply) => {
    enabled().delete(otherUser(req));
    return reply.code(204).send();
  });

  // System: yt-dlp status and one-click update

  app.get("/api/system", (req) => systemInfo(langOf(req)));

  app.post("/api/system/ytdlp", async (req) => {
    if (users) admin(req);
    const { channel } = (req.body ?? {}) as { channel?: string };
    return presentJob(startJob((channel === "nightly" ? "nightly" : "stable") satisfies Channel), langOf(req));
  });

  // Discovery

  app.get("/api/search", async (req) => {
    const { q, type } = req.query as { q?: string; type?: string };
    return { tracks: await search(query(q), type === "video" ? "video" : "song", langOf(req)) };
  });

  app.get("/api/suggest", async (req) => {
    const { q } = req.query as { q?: string };
    if (!q?.trim()) return { suggestions: [] };
    return { suggestions: await suggestions(q.trim().slice(0, 100), langOf(req)).catch(() => []) };
  });

  app.get("/api/radio/:id", async (req) => ({ tracks: await radio(videoId(req.params)) }));

  // Browse by genre: genre → its artists or all its songs → an artist's top songs

  app.get("/api/genres", async (req) => ({ genres: await genres(langOf(req)) }));

  // Discover (Home): the catalog's picks (the same for everyone) and the moods, as in YouTube Music.
  app.get("/api/home", (req) => home(langOf(req)));
  app.get("/api/moods", async (req) => ({ moods: await moods(langOf(req)) }));

  /** This person's Weekly Mix (null with an empty library): from their own favorites, history and recent plays. */
  app.get("/api/weekly-mix", async (req) => {
    const lib = libOf(req);
    const [library, top] = await Promise.all([lib.getLibraryLite(), lib.topPlays(Date.now() - 28 * 24 * 3600_000, 30)]);
    const mix = await weeklyMix(
      String(req.user?.id ?? DEFAULT_USER),
      { favorites: library.favorites, history: library.history, top: top.map((p) => p.track) },
      langOf(req),
    ).catch(() => null);
    return { mix };
  });

  app.get("/api/genres/:gid", async (req) => {
    const { gid } = req.params as { gid: string };
    if (!GENRE_ID.test(gid)) throw new HttpError(400, msg("invalidGenre"));
    return genre(gid, langOf(req));
  });

  /** "Load more" for a genre's artists: `offset` is how many the app already shows. */
  app.get("/api/genres/:gid/artists", async (req) => {
    const { gid } = req.params as { gid: string };
    const offset = Number((req.query as { offset?: string }).offset ?? 0);
    if (!GENRE_ID.test(gid)) throw new HttpError(400, msg("invalidGenre"));
    if (!Number.isInteger(offset) || offset < 0 || offset > 1000) throw new HttpError(400, msg("invalidOffset"));
    return genreArtists(gid, offset, langOf(req));
  });

  app.get("/api/artists/:aid", async (req) => {
    const { aid } = req.params as { aid: string };
    if (!ARTIST_ID.test(aid)) throw new HttpError(400, msg("invalidArtist"));
    return artist(aid, langOf(req));
  });

  // The profile: the most played (the last 3 months, or ever) and artists to try.
  // ?since= (ms) for a period of your own; first: the oldest play on record, so a period doesn't reach past it.
  app.get("/api/profile/top", async (req) => {
    const { range, since: from, limit } = req.query as { range?: string; since?: string; limit?: string };
    const asked = Math.trunc(Number(from));
    const since = Number.isFinite(asked) && asked > 0 ? Math.min(asked, Date.now()) : range === "all" ? 0 : Date.now() - PROFILE_RANGE_MS;
    const n = Math.min(Math.max(Math.trunc(Number(limit)) || 5, 1), 100);
    const lib = libOf(req);
    return { plays: await lib.topPlays(since, n), first: await lib.firstPlay() };
  });

  // Your listening, for the statistics: every play in a period, the tracks they name, and the first play on record.
  app.get("/api/profile/log", async (req) => {
    const q = req.query as { since?: string; until?: string };
    const until = Math.min(Math.trunc(Number(q.until)) || Date.now(), Date.now());
    const since = Math.max(Math.trunc(Number(q.since)) || 0, 0);
    const lib = libOf(req);
    const log = await lib.playLog(since, until);
    // Rows name tracks by their place in the list: much smaller than repeating every track.
    const at = new Map(log.tracks.map((t, i) => [t.id, i]));
    return {
      tracks: log.tracks,
      rows: log.rows.flatMap(([id, when, n, restored]) => (at.has(id) ? [[at.get(id)!, when, n, restored]] : [])),
      first: await lib.firstPlay(),
      dated: log.dated,
    };
  });

  // Settings that follow the account to every device (the accent colour, the profile's default period).
  const settingsOf = (req: FastifyRequest) => path.join(config.dataDir, "settings", `${req.user?.id ?? DEFAULT_USER}.json`);
  const readSettings = async (req: FastifyRequest): Promise<AccountSettings> => {
    try {
      return cleanSettings(JSON.parse(await fs.promises.readFile(settingsOf(req), "utf8")));
    } catch {
      return { accent: null, profilePeriod: null };
    }
  };
  app.get("/api/profile/settings", async (req) => readSettings(req));
  app.put("/api/profile/settings", async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const next = cleanSettings({ ...(await readSettings(req)), ...body });
    const file = settingsOf(req);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, JSON.stringify(next));
    return next;
  });

  // The profile picture: one per account, kept as a small image (data: URL) in the data folder.
  const pictureOf = (req: FastifyRequest) => path.join(config.dataDir, "avatars", `${req.user?.id ?? DEFAULT_USER}.txt`);
  app.get("/api/profile/image", async (req) => ({
    image: await fs.promises.readFile(pictureOf(req), "utf8").catch(() => null),
  }));
  app.put("/api/profile/image", { bodyLimit: 1_048_576 }, async (req) => {
    const image = (req.body as { image?: unknown } | null)?.image;
    const file = pictureOf(req);
    if (image === null) {
      await fs.promises.rm(file, { force: true });
      return { image: null };
    }
    if (typeof image !== "string" || image.length > 700_000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) {
      throw new HttpError(400, msg("badImage"));
    }
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, image);
    return { image };
  });

  // Worked out from a dozen artist pages: kept a day per account and language, refreshed in the background after.
  const discovered = new Map<string, { at: number; value: Discover | null; running: Promise<Discover> | null }>();
  app.get("/api/profile/discover", async (req) => {
    const lang = langOf(req);
    const key = `${req.user?.id ?? DEFAULT_USER}:${lang}`;
    const lib = libOf(req);
    let e = discovered.get(key);
    if (!e) discovered.set(key, (e = { at: 0, value: null, running: null }));
    const entry = e;
    if (!entry.running && Date.now() - entry.at > DISCOVER_MS) {
      entry.running = (async () => discover(await lib.allPlays(), (await lib.getLibraryLite()).artists, (id) => artist(id, lang)))()
        .then((value) => {
          entry.value = value;
          entry.at = Date.now();
          return value;
        })
        .finally(() => (entry.running = null));
      entry.running.catch(() => {});
    }
    return entry.value ?? (await entry.running!);
  });

  // Off Recently played; or damnatio memoriae: no trace of the track's plays left, the suggestions worked out again.
  app.delete("/api/history/:id", async (req) => ({
    history: await libOf(req).removeFromHistory(videoId(req.params)),
  }));
  app.delete("/api/plays/:id", async (req) => {
    const history = await libOf(req).forget(videoId(req.params));
    const user = `${req.user?.id ?? DEFAULT_USER}:`;
    for (const key of discovered.keys()) if (key.startsWith(user)) discovered.delete(key);
    return { history };
  });

  app.get("/api/albums/:alid", async (req) => {
    const { alid } = req.params as { alid: string };
    if (!ALBUM_ID.test(alid)) throw new HttpError(400, msg("invalidAlbum"));
    return album(alid, langOf(req));
  });

  app.get("/api/search/albums", async (req) => {
    const { q } = req.query as { q?: string };
    return { albums: await searchAlbums(query(q), langOf(req)) };
  });

  app.get("/api/search/playlists", async (req) => {
    const { q } = req.query as { q?: string };
    return { playlists: await searchPlaylists(query(q), langOf(req)) };
  });

  app.get("/api/yt-playlists/:pid", async (req) => {
    const { pid } = req.params as { pid: string };
    if (!YT_PLAYLIST_ID.test(pid)) throw new HttpError(400, msg("invalidYtPlaylist"));
    return ytPlaylist(pid, langOf(req));
  });

  app.get("/api/search/artists", async (req) => {
    const { q } = req.query as { q?: string };
    return { artists: await searchArtists(query(q), langOf(req)) };
  });

  /** The music video for a song, so "Vídeo" mode can show the clip instead of a still cover. */
  app.get("/api/video-for/:id", async (req) => {
    const { title, artist, duration } = req.query as { title?: string; artist?: string; duration?: string };
    if (!title?.trim()) throw new HttpError(400, msg("missingTitle"));
    const track = await findVideoFor(videoId(req.params), title.slice(0, 200), (artist ?? "").slice(0, 200), Number(duration) || 0);
    return { track };
  });

  // Lyrics (LRCLIB)

  /** The track's lyrics, timed when LRCLIB has them timed: `lyrics` is null when there are none. */
  app.get("/api/lyrics/:id", async (req) => {
    const { title, artist, album, duration } = req.query as {
      title?: string;
      artist?: string;
      album?: string;
      duration?: string;
    };
    if (!title?.trim()) throw new HttpError(400, msg("missingTitle"));
    const lyrics = await lyricsFor({
      id: videoId(req.params),
      title: title.slice(0, 200),
      artist: (artist ?? "").slice(0, 200),
      album: (album ?? "").slice(0, 200),
      duration: Number(duration) || 0,
    });
    return { lyrics };
  });

  // Playback

  /** Resolves stream URLs ahead of time so the next track starts instantly. */
  app.post("/api/prepare/:id", async (req) => {
    const r = await resolveStreams(videoId(req.params));
    return { id: r.id, title: r.title, duration: r.duration, hasSdVideo: !!r.video };
  });

  /** How much louder than YouTube's reference the track is (dB), or null: the player evens out the volume with it. */
  app.get("/api/loudness/:id", async (req) => ({ loudnessDb: await loudnessOf(videoId(req.params)).catch(() => null) }));

  /** The video qualities a track comes in here (lines, e.g. 720), under MUSIKE_VIDEO_MAX_HEIGHT. */
  app.get("/api/video-qualities/:id", async (req) => videoQualities(videoId(req.params)));

  /**
   * A video downloaded ahead in a quality (?h=, e.g. 1080), so the player can switch to it without waiting: the
   * Auto quality does this when the video is shown big. /hd is the older name for 720.
   */
  const prepareVideo = async (id: string, height: number, reply: FastifyReply) => {
    if (height <= 360 && (await resolveStreams(id)).video) return { ready: true, height: 360 };
    // The player gone (it skipped the track): it no longer waits for this download (see downloadVideo).
    const file = await downloadVideo(id, height, gone(reply));
    // The quality it really has: the nearest under the one asked for, when the video doesn't have that.
    return { ready: true, height: heightOfFile(file) };
  };
  app.post("/api/prepare/:id/video", async (req, reply) => prepareVideo(videoId(req.params), heightOf(req.query), reply));
  app.post("/api/prepare/:id/hd", async (req, reply) => prepareVideo(videoId(req.params), 720, reply));

  /**
   * The audio of a track coming up, fetched into the cache in the background (the answer doesn't wait for it): when
   * it's its turn it plays from the server's disk, at once. The player asks for the next tracks of its queue.
   */
  app.post("/api/prefetch/:id/audio", async (req, reply) => {
    const id = videoId(req.params);
    cacheAudio(id).catch((err) => req.log.debug({ videoId: id, err: String(err) }, "Audio fetched ahead failed"));
    return reply.code(202).send({ queued: true });
  });

  /** From the cache when it was fetched ahead, else from YouTube through this server. */
  app.get("/api/stream/:id/audio", (req, reply) => {
    const id = videoId(req.params);
    const cached = cachedAudio(id);
    return cached ? serveFile(req, reply, cached.file, cached.mime) : proxyStream(req, reply, id, "audio");
  });

  /** ?h= a quality (e.g. 1080), downloaded first; none (or 360) the ready-made SD stream, when YouTube has one. */
  app.get("/api/stream/:id/video", async (req, reply) => {
    const id = videoId(req.params);
    const height = heightOf(req.query);
    if (height <= 360) {
      const resolved = await resolveStreams(id);
      if (resolved.video) return proxyStream(req, reply, id, "video");
    }
    return serveFile(req, reply, await downloadVideo(id, height || 360, gone(reply)), "video/mp4");
  });

  // Library

  app.get("/api/library", (req) => libOf(req).getLibraryLite());

  /** The play log: one artist's tracks (most played first), or all of it (for backups). */
  app.get("/api/plays", async (req) => {
    const { artist, name } = req.query as { artist?: string; name?: string };
    if (artist === undefined) return { plays: await libOf(req).allPlays() };
    if (!ARTIST_ID.test(artist)) throw new HttpError(400, msg("invalidArtist"));
    return { plays: await libOf(req).playsFor(artist, String(name ?? "").slice(0, 300)) };
  });

  /** Restores a backup file exported by any Musike instance. Big libraries need more than the 1 MB default body. */
  app.post("/api/library/import", { bodyLimit: 25 * 1024 * 1024 }, async (req) => {
    const body = (req.body ?? {}) as { backup?: { format?: unknown; version?: unknown; library?: unknown }; mode?: unknown };
    const backup = body.backup;
    if (backup?.format !== "musike-backup") throw new HttpError(400, msg("notBackup"));
    if (typeof backup.version !== "number" || backup.version > 1) {
      throw new HttpError(400, msg("newerBackup"));
    }
    return libOf(req).importLibrary(backup.library, body.mode === "replace" ? "replace" : "merge");
  });

  app.put("/api/favorites/:id", async (req) => {
    const track = library.sanitizeTrack(req.body);
    if (track.id !== videoId(req.params)) throw new HttpError(400, msg("idMismatch"));
    return { favorites: await libOf(req).addFavorite(track) };
  });

  /** Bulk add, e.g. from the list search. */
  app.post("/api/favorites", async (req) => {
    const { tracks } = (req.body ?? {}) as { tracks?: unknown };
    if (!Array.isArray(tracks)) throw new HttpError(400, msg("tracksRequired"));
    return { favorites: await libOf(req).addFavorites(tracks.slice(0, 500).map(library.sanitizeTrack)) };
  });

  app.delete("/api/favorites/:id", async (req) => ({ favorites: await libOf(req).removeFavorite(videoId(req.params)) }));

  // ?at=: when the track was played (ms), for plays a phone made while the server was out of reach.
  app.post("/api/history", async (req) => {
    const history = await libOf(req).pushHistory(library.sanitizeTrack(req.body), (req.query as { at?: unknown }).at);
    sync.changed(req.user?.id ?? DEFAULT_USER, "history", deviceOf(req), history);
    return { history };
  });

  /** The Search page's "Recent" list: what you searched for, opened or played. */
  app.get("/api/recent", async (req) => ({ recent: await libOf(req).recent() }));

  app.post("/api/recent", async (req) => ({ recent: await libOf(req).pushRecent(library.sanitizeRecent(req.body)) }));

  app.delete("/api/recent/:kind/:id", async (req) => {
    const { kind, id } = req.params as { kind: string; id: string };
    return { recent: await libOf(req).removeRecent(kind.slice(0, 20), id.slice(0, 200)) };
  });

  app.delete("/api/recent", async (req) => ({ recent: await libOf(req).clearRecent() }));

  /** Artists and albums kept in the library. */
  app.put("/api/library/artists/:aid", async (req) => {
    const saved = library.sanitizeArtist(req.body);
    if (saved.id !== (req.params as { aid: string }).aid) throw new HttpError(400, msg("idMismatch"));
    return { artists: await libOf(req).saveArtist(saved) };
  });

  app.delete("/api/library/artists/:aid", async (req) => {
    const { aid } = req.params as { aid: string };
    if (!ARTIST_ID.test(aid)) throw new HttpError(400, msg("invalidArtist"));
    return { artists: await libOf(req).removeArtist(aid) };
  });

  app.put("/api/library/albums/:alid", async (req) => {
    const saved = library.sanitizeAlbum(req.body);
    if (saved.id !== (req.params as { alid: string }).alid) throw new HttpError(400, msg("idMismatch"));
    return { albums: await libOf(req).saveAlbum(saved) };
  });

  app.put("/api/library/yt-playlists/:pid", async (req) => {
    const saved = library.sanitizeYtPlaylist(req.body);
    if (saved.id !== (req.params as { pid: string }).pid) throw new HttpError(400, msg("idMismatch"));
    return { ytPlaylists: await libOf(req).saveYtPlaylist(saved) };
  });

  app.delete("/api/library/yt-playlists/:pid", async (req) => {
    const { pid } = req.params as { pid: string };
    if (!YT_PLAYLIST_ID.test(pid)) throw new HttpError(400, msg("invalidYtPlaylist"));
    return { ytPlaylists: await libOf(req).removeYtPlaylist(pid) };
  });

  app.delete("/api/library/albums/:alid", async (req) => {
    const { alid } = req.params as { alid: string };
    if (!ALBUM_ID.test(alid)) throw new HttpError(400, msg("invalidAlbum"));
    return { albums: await libOf(req).removeAlbum(alid) };
  });

  app.post("/api/playlists", async (req) => {
    const body = (req.body ?? {}) as { name?: unknown; tracks?: unknown };
    const tracks = Array.isArray(body.tracks) ? body.tracks.slice(0, 500).map(library.sanitizeTrack) : [];
    return libOf(req).createPlaylist(typeof body.name === "string" ? body.name : "", tracks);
  });

  app.patch("/api/playlists/:pid", async (req) => {
    const { pid } = req.params as { pid: string };
    const { name } = (req.body ?? {}) as { name?: unknown };
    return libOf(req).renamePlaylist(pid, typeof name === "string" ? name : "");
  });

  app.delete("/api/playlists/:pid", async (req, reply) => {
    await libOf(req).deletePlaylist((req.params as { pid: string }).pid);
    return reply.code(204).send();
  });

  /** One track, or `{ tracks: [...] }` to add many at once. */
  app.post("/api/playlists/:pid/tracks", async (req) => {
    const body = (req.body ?? {}) as { tracks?: unknown };
    const tracks = Array.isArray(body.tracks) ? body.tracks.slice(0, 500).map(library.sanitizeTrack) : library.sanitizeTrack(req.body);
    return libOf(req).addToPlaylist((req.params as { pid: string }).pid, tracks);
  });

  /**
   * The radio playlist for a radio just started (`{ name, seed, tracks }`, the tracks as queued): the one there was,
   * not saved, goes. The app asks first when that one had been changed.
   */
  app.post("/api/playlists/radio", async (req) => {
    const body = (req.body ?? {}) as { name?: unknown; seed?: unknown; tracks?: unknown };
    const seed = typeof body.seed === "string" && VIDEO_ID.test(body.seed) ? body.seed : "";
    if (!seed) throw new HttpError(400, msg("invalidTrack"));
    const tracks = Array.isArray(body.tracks) ? body.tracks.slice(0, 500).map(library.sanitizeTrack) : [];
    return libOf(req).createRadioPlaylist(typeof body.name === "string" ? body.name : "", seed, tracks);
  });

  /** A radio playlist's kept tracks, or its regenerated tracks: `{ tracks?, kept?, discarded? }`. */
  app.patch("/api/playlists/:pid/radio", async (req) =>
    libOf(req).updateRadioPlaylist((req.params as { pid: string }).pid, library.sanitizeRadioPatch(req.body)),
  );

  /** A radio playlist saved as a playlist like the others. */
  app.post("/api/playlists/:pid/save", async (req) => libOf(req).saveRadioPlaylist((req.params as { pid: string }).pid));

  /** The playlist's tracks in a new order: `{ ids: [...] }`. */
  app.put("/api/playlists/:pid/order", async (req) => {
    const { ids } = (req.body ?? {}) as { ids?: unknown };
    if (!Array.isArray(ids)) throw new HttpError(400, msg("tracksRequired"));
    const clean = ids.slice(0, 5000).filter((id): id is string => typeof id === "string" && VIDEO_ID.test(id));
    return libOf(req).reorderPlaylist((req.params as { pid: string }).pid, clean);
  });
    app.delete("/api/playlists/:pid/tracks/:id", async (req) =>
    libOf(req).removeFromPlaylist((req.params as { pid: string }).pid, videoId(req.params)),
  );

  // Web app (production build)

  if (existsSync(config.webDist)) {
    // Wildcard mode resolves files per request, so rebuilding the web app never needs a server restart.
    await app.register(fastifyStatic, { root: config.webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) return reply.sendFile("index.html");
      reply.code(404).send({ error: tr(langOf(req), msg("routeNotFound")) });
    });
  }

  const host = opts.host ?? config.host;
  const preferred = opts.port ?? config.port;
  const port = opts.portFallback ? await freePort(preferred, host) : preferred;
  try {
    await app.listen({ port, host });
  } catch (e) {
    sync.close();
    store.close();
    throw e;
  }

  pruneCache().catch(() => {});
  const stopChannel = config.ytdlpChannel ? keepChannel(config.ytdlpChannel) : () => {};
  const stopBackups = keepBackups(store);
  return {
    port,
    tools: found,
    library: store.kind,
    accounts: !users ? "off" : users.needsSetup() ? "setup" : "on",
    setupCode: users?.needsSetup() ? code : null,
    close: async () => {
      stopChannel();
      stopBackups();
      sync.close();
      await app.close();
      store.close();
    },
  };
}

/** First free port from `start` (up to 10 tries), so a second copy or a dev server doesn't block launch. */
async function freePort(start: number, host: string): Promise<number> {
  for (let port = start; port < start + 10; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer()
        .once("error", () => resolve(false))
        .once("listening", () => probe.close(() => resolve(true)))
        .listen(port, host);
    });
    if (free) return port;
  }
  throw new HttpError(500, msg("noFreePort", { from: start, to: start + 9 }));
}
