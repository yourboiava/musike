import type { Innertube } from "youtubei.js";
import { config } from "./config.js";
import { isLang, msg, tr, youtubeLang, type Lang } from "./i18n.js";
import { artistIdOf, radio, sized, text, toTrack, videoThumbs, withClient } from "./search.js";
import type { Track } from "./types.js";
import { ALBUM_ID, ARTIST_ID, HttpError, VIDEO_ID, YT_PLAYLIST_ID } from "./types.js";

export { ALBUM_ID, ARTIST_ID, YT_PLAYLIST_ID };

export interface Genre {
  /** YouTube Music's opaque "params" for the genre page. */
  id: string;
  name: string;
}

export interface GenreArtist {
  id: string;
  name: string;
  /** Cover of one of their releases in this genre (artist photos would cost a request each). */
  thumb: string;
  art: string;
  /** A few of their songs in this genre, to recognize them by. */
  hits: string[];
}

export interface GenrePage {
  id: string;
  name: string;
  /** The first page of artists; more come from `genreArtists`. */
  artists: GenreArtist[];
  hasMoreArtists: boolean;
  tracks: Track[];
}

/** An album or single as a cover in a list (artist page, search). */
export interface AlbumCard {
  id: string;
  title: string;
  /** Empty on an artist's own page, where it goes without saying. */
  artist: string;
  year: string;
  thumb: string;
  art: string;
}

/** An artist as a search result. */
export interface ArtistCard {
  id: string;
  name: string;
  /** YouTube Music's own line, in the request's language: "Artist • 1.2M subscribers". */
  info: string;
  thumb: string;
  art: string;
}

export interface ArtistPage {
  id: string;
  name: string;
  description: string;
  banner: string;
  /** Top songs, most played first (YouTube Music's play counts), up to MAX_HITS. */
  tracks: Track[];
  albums: AlbumCard[];
  singles: AlbumCard[];
  /** The page's other shelves, in YouTube Music's order and with its (translated) titles. */
  shelves: ArtistShelf[];
}

/** A shelf of an artist page: videos (live performances too), playlists (featured on, by the artist) or artists. */
export type ArtistShelf =
  | { kind: "videos"; title: string; tracks: Track[] }
  | { kind: "playlists"; title: string; playlists: PlaylistCard[] }
  | { kind: "artists"; title: string; artists: ArtistCard[] };

/** A YouTube Music playlist as a search result. */
export interface PlaylistCard {
  id: string;
  title: string;
  /** YouTube Music's own line, in the request's language: "Playlist • Someone • 1.2M views". */
  info: string;
  thumb: string;
  art: string;
}

/** A YouTube Music playlist and its tracks (the first page, up to MAX_PLAYLIST_TRACKS). */
export interface YtPlaylistPage {
  id: string;
  title: string;
  author: string;
  info: string;
  description: string;
  thumb: string;
  art: string;
  tracks: Track[];
}

export interface AlbumPage {
  id: string;
  title: string;
  artist: string;
  artistId: string | null;
  /** YouTube Music's own lines, in the request's language: "Album • 1991", "13 songs • 49 minutes". */
  kind: string;
  info: string;
  thumb: string;
  art: string;
  tracks: Track[];
  /** The album as a playlist (OLAK5uy_...): its address on YouTube, where albums have no page of their own. */
  playlistId?: string;
}


export const GENRE_ID = /^[\w-]{8,120}={0,2}$/;

const MINUTE = 60_000;
const ARTISTS_PAGE = 40;
/** Enough for anyone browsing; stops reading playlists after that. */
const MAX_ARTISTS = 600;
const PLAYLISTS_PER_ROUND = 4;
const MAX_GENRE_TRACKS = 150;
const MAX_HITS = 50;
const MAX_PLAYLIST_TRACKS = 200;

/** Time-boxed memo: these pages change slowly, and going back and forth between them should be instant. */
function cached<T>(ttl: number, load: (key: string) => Promise<T>): (key: string) => Promise<T> {
  const memo = new Map<string, { at: number; value: Promise<T> }>();
  return (key) => {
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    if (memo.size > 200) memo.delete(memo.keys().next().value!);
    const value = load(key);
    memo.set(key, { at: Date.now(), value });
    // Failures are not cached, so the next visit tries again.
    value.catch(() => memo.get(key)?.value === value && memo.delete(key));
    return value;
  };
}

// youtubei.js has no typed helper for the genre pages, so these responses are read defensively.
const browse = (yt: Innertube, payload: Record<string, unknown>): Promise<any> =>
  yt.actions.execute("/browse", { ...payload, client: "YTMUSIC", parse: true });

function shelvesOf(page: any): any[] {
  const root = typeof page?.contents?.item === "function" ? page.contents.item() : page?.contents;
  return root?.tabs?.[0]?.content?.contents ?? [];
}

const itemsOf = (shelf: any): any[] => shelf?.contents ?? shelf?.items ?? [];

function imagesOf(item: any): { thumb: string; art: string } {
  const thumbs = item?.thumbnail?.contents ?? item?.thumbnail ?? item?.thumbnails ?? [];
  const url: string | undefined = Array.isArray(thumbs) ? thumbs[0]?.url : undefined;
  return { thumb: sized(url, 240), art: sized(url, 544) };
}

/** Same song twice (another upload, a playlist repeat) only shows once. */
function uniqueTracks(tracks: (Track | null)[]): Track[] {
  const seen = new Set<string>();
  return tracks.filter((t): t is Track => {
    if (!t) return false;
    const key = `${t.title}|${t.artist}`.toLocaleLowerCase("pt-BR");
    if (seen.has(t.id) || seen.has(key)) return false;
    seen.add(t.id);
    seen.add(key);
    return true;
  });
}

/** [[a1, a2], [b1]] → [a1, b1, a2] */
function roundRobin<T>(lists: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]!);
  return out;
}

/** "Céu Azul (Ao Vivo)" → "Céu Azul": enough to recognize the song in a short preview. */
const bareTitle = (title: string) => title.replace(/\s*[([].*?[)\]]/g, "").trim() || title;

// Pages are cached per language: YouTube Music words genre names and bios in the session's language.
const keyOf = (lang: Lang, id = "") => `${lang}|${id}`;
function parseKey(key: string): { lang: Lang; id: string } {
  const [lang = "", ...rest] = key.split("|");
  return { lang: isLang(lang) ? lang : "en", id: rest.join("|") };
}

/** A grid of buttons (genres, or moods) as plain id/name pairs: opened the same way either kind. */
const buttonList = (grid: any): Genre[] =>
  itemsOf(grid)
    .map((b: any) => ({ id: String(b.endpoint?.payload?.params ?? ""), name: text(b.button_text ?? b.title) }))
    .filter((g: Genre) => GENRE_ID.test(g.id) && g.name);

/**
 * One page holds both grids ("Moods & moments" then "Genres"): fetched once and split here, so `genres()` and
 * `moods()` share the same cache instead of asking YouTube twice for the same page.
 */
const moodsAndGenres = cached(6 * 60 * MINUTE, async (key): Promise<{ genres: Genre[]; moods: Genre[] }> => {
  const { lang } = parseKey(key);
  const page = await withClient((yt) => browse(yt, { browseId: "FEmusic_moods_and_genres" }), lang).catch(() => {
    throw new HttpError(502, msg("genresUnavailable"));
  });
  const grids = shelvesOf(page);
  // The page has "moods" then "genres"; match the genres title in any language, falling back to the last grid.
  const genreGrid = grids.find((g) => /g[eéê]ne?r/i.test(text(g.header?.title ?? g.title))) ?? grids.at(-1);
  const moodGrid = grids.find((g) => g !== genreGrid) ?? grids[0];
  return { genres: buttonList(genreGrid), moods: buttonList(moodGrid) };
});

export const genres = async (lang: Lang) => (await moodsAndGenres(keyOf(lang))).genres;
/** A mood opens like a genre: same id shape, same `genre()` page. */
export const moods = async (lang: Lang) => (await moodsAndGenres(keyOf(lang))).moods;

async function playlistItems(id: string, limit: number, lang: Lang): Promise<any[]> {
  try {
    const list = await withClient((yt) => yt.music.getPlaylist(id), lang);
    return ((list as any).items ?? (list as any).contents ?? []).slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Ranks the artists credited on `sources` by how often they show up (times the source's weight),
 * skipping the ones already `known`. Channels that are not artist pages (labels, uploaders) are left out.
 */
function rankArtists(sources: { items: any[]; weight: number; hits: boolean }[], known: Set<string>): GenreArtist[] {
  const ranked = new Map<string, GenreArtist & { score: number }>();
  for (const { items, weight, hits } of sources) {
    for (const item of items) {
      const hit = hits ? bareTitle(text(item.title)) : "";
      for (const a of item.artists ?? []) {
        const pageType = a?.endpoint?.payload?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
        if (!ARTIST_ID.test(a?.channel_id ?? "") || known.has(a.channel_id)) continue;
        if (pageType && pageType !== "MUSIC_PAGE_TYPE_ARTIST") continue;
        let entry = ranked.get(a.channel_id);
        if (!entry) {
          entry = { id: a.channel_id, name: text(a.name), ...imagesOf(item), hits: [], score: 0 };
          ranked.set(a.channel_id, entry);
        }
        entry.score += weight;
        if (hit && entry.hits.length < 3 && !entry.hits.includes(hit)) entry.hits.push(hit);
      }
    }
  }
  return [...ranked.values()]
    .filter((a) => a.name)
    .sort((a, b) => b.score - a.score)
    .map(({ score: _, ...a }) => a);
}

/** What a genre has turned up so far. "Load more" keeps reading its playlists for artists not seen yet. */
interface GenreState {
  page: GenrePage;
  /** Every artist found so far, in a fixed order: later pages append, never reshuffle earlier ones. */
  pool: GenreArtist[];
  /** Playlists not read yet. */
  queue: string[];
  lang: Lang;
  extending?: Promise<void>;
}

/**
 * A genre's songs and the artists behind them. The page lists ~50 songs, playlists and albums;
 * two editorial playlists widen the song list (and are all there is for pages like "Décadas").
 */
const genreState = cached(30 * MINUTE, async (key): Promise<GenreState> => {
  const { lang, id } = parseKey(key);
  const [all, page] = await Promise.all([
    genres(lang).catch(() => [] as Genre[]),
    withClient((yt) => browse(yt, { browseId: "FEmusic_moods_and_genres_category", params: id }), lang).catch(() => {
      throw new HttpError(502, msg("genreUnavailable"));
    }),
  ]);
  const shelves = shelvesOf(page);
  const items = shelves.flatMap(itemsOf);
  const songs = items.filter((i) => i.item_type === "song");
  const albums = items.filter((i) => i.item_type === "album");

  // One playlist from each shelf in turn (so "Décadas" mixes decades), editorial ("RDCLAK...") before
  // community ones, which are hit and miss.
  const perShelf = shelves.map((s) => itemsOf(s).filter((i) => i.item_type === "playlist" && typeof i.id === "string"));
  const editorial = (p: any) => /RDCLAK/.test(p.id);
  const playlists = [
    ...new Set(
      [...roundRobin(perShelf.map((list) => list.filter(editorial))), ...roundRobin(perShelf.map((list) => list.filter((p) => !editorial(p))))].map(
        (p): string => p.id,
      ),
    ),
  ];
  const first = songs.length >= 10 ? 2 : 4;
  const fromPlaylists = (await Promise.all(playlists.slice(0, first).map((p) => playlistItems(p, 60, lang)))).flat();

  const tracks = uniqueTracks([...songs, ...fromPlaylists].map((i) => toTrack(i, "song"))).slice(0, MAX_GENRE_TRACKS);
  if (!tracks.length && !albums.length) throw new HttpError(404, msg("genreEmpty"));

  // The genre's own song and album shelves weigh more than playlists.
  const pool = rankArtists(
    [
      { items: songs, weight: 2, hits: true },
      { items: albums, weight: 2, hits: false },
      { items: fromPlaylists, weight: 1, hits: true },
    ],
    new Set(),
  );
  // More artists come from the remaining editorial playlists; community ones only when there is nothing else.
  const rest = playlists.slice(first);
  const queue = rest.some((p) => /RDCLAK/.test(p)) ? rest.filter((p) => /RDCLAK/.test(p)) : rest;

  return {
    page: {
      id,
      name: all.find((g) => g.id === id)?.name ?? "",
      artists: pool.slice(0, ARTISTS_PAGE),
      hasMoreArtists: pool.length > ARTISTS_PAGE || queue.length > 0,
      tracks,
    },
    pool,
    queue,
    lang,
  };
});

export const genre = async (id: string, lang: Lang): Promise<GenrePage> => (await genreState(keyOf(lang, id))).page;

/** Reads the next few playlists of the genre and appends the artists they bring. */
async function extend(state: GenreState): Promise<void> {
  const batch = state.queue.splice(0, PLAYLISTS_PER_ROUND);
  const items = (await Promise.all(batch.map((p) => playlistItems(p, 100, state.lang)))).flat();
  state.pool.push(...rankArtists([{ items, weight: 1, hits: true }], new Set(state.pool.map((a) => a.id))));
  if (state.pool.length >= MAX_ARTISTS) state.queue.length = 0;
}

/** The next page of a genre's artists, reading more of its playlists when the ones found so far run out. */
export async function genreArtists(id: string, offset: number, lang: Lang): Promise<{ artists: GenreArtist[]; hasMore: boolean }> {
  const state = await genreState(keyOf(lang, id));
  // A few rounds at most per request, so a run of playlists with no new names can't stall it.
  for (let round = 0; round < 5 && state.pool.length < offset + ARTISTS_PAGE && state.queue.length; round++) {
    // Two "load more" taps at once share the same read instead of skipping playlists.
    state.extending ??= extend(state).finally(() => (state.extending = undefined));
    await state.extending;
  }
  return {
    artists: state.pool.slice(offset, offset + ARTISTS_PAGE),
    hasMore: state.pool.length > offset + ARTISTS_PAGE || state.queue.length > 0,
  };
}

/** An artist's most played songs (the "Top songs" shelf, expanded to its full list). */
function albumCard(item: any): AlbumCard | null {
  const id = typeof item?.id === "string" ? item.id : "";
  if (!ALBUM_ID.test(id)) return null;
  const subtitle = text(item.subtitle);
  const artists: string[] = (item.artists ?? []).map((a: { name?: string }) => text(a?.name)).filter(Boolean);
  return {
    id,
    title: text(item.title),
    artist: artists.join(", ") || text(item.author?.name),
    year: String(item.year ?? subtitle.match(/\b(19|20)\d\d\b/)?.[0] ?? ""),
    ...imagesOf(item),
  };
}

const albumCards = (items: any[]) => items.map(albumCard).filter((a): a is AlbumCard => !!a && !!a.title);

/** Every album of an artist: the page shows ten, its "more" link opens the whole discography. */
async function allAlbums(shelf: any, lang: Lang): Promise<AlbumCard[]> {
  const shown = albumCards(itemsOf(shelf));
  const more = shelf?.header?.more_content?.endpoint?.payload;
  if (!more?.browseId) return shown;
  try {
    const page = await withClient((yt) => browse(yt, { browseId: more.browseId, params: more.params }), lang);
    const all = albumCards(page.contents_memo?.get("MusicTwoRowItem") ?? []);
    return all.length >= shown.length ? all : shown;
  } catch {
    return shown;
  }
}

/**
 * A count as YouTube Music words it, in English or Portuguese: "235M plays", "1.2K", "1,2 mi de reproduções",
 * "3,4 mil", "1,234 plays". Undefined when there is no number.
 */
export function parseCount(s: string): number | undefined {
  const m = /(\d+(?:[.,]\d+)*)\s*(mld|mln|mil|mi|bi|k|m|b)?(?![\p{L}])/iu.exec(s);
  if (!m) return undefined;
  const scale: Record<string, number> = { k: 1e3, mil: 1e3, m: 1e6, mi: 1e6, mln: 1e6, b: 1e9, bi: 1e9, mld: 1e9 };
  const unit = m[2]?.toLowerCase();
  // With a unit the separator is a decimal point ("1.2M", "1,2 mi"); without one it groups thousands ("1,234").
  const n = unit ? Number(m[1].replace(",", ".")) * scale[unit] : Number(m[1].replace(/[.,]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** The play count column of a top-songs row: the one that starts with a number and links nowhere. */
function playsOf(item: any): string | undefined {
  for (const col of (item?.flex_columns ?? []).slice(1)) {
    const runs: any[] = col?.title?.runs ?? [];
    const words = text(col?.title).trim();
    if (/^\d/.test(words) && !runs.some((r) => r?.endpoint)) return words;
  }
  return undefined;
}

/** Most played first; tracks without a count keep their place after the counted ones. */
export function byPlays(tracks: Track[]): Track[] {
  return tracks
    .map((t, i) => ({ t, i, n: t.plays ? (parseCount(t.plays) ?? -1) : -1 }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map((x) => x.t);
}

function videoTrack(item: any): Track | null {
  const id = item?.id;
  if (typeof id !== "string" || !VIDEO_ID.test(id)) return null;
  const title = text(item.title);
  if (!title) return null;
  const subtitle = text(item.subtitle);
  return {
    id,
    title,
    artist: text(item.author?.name) || subtitle.split(" • ")[0] || "",
    artistId: ARTIST_ID.test(item.author?.channel_id ?? "") ? item.author.channel_id : undefined,
    duration: 0,
    ...videoThumbs(id),
    kind: "video",
  };
}

function playlistCard(item: any): PlaylistCard | null {
  const raw = typeof item?.id === "string" ? item.id : "";
  const id = raw.startsWith("VL") ? raw : `VL${raw}`;
  const title = text(item?.title);
  if (!YT_PLAYLIST_ID.test(id) || !title) return null;
  return { id, title, info: text(item.subtitle), ...imagesOf(item) };
}

function artistCard(item: any): ArtistCard | null {
  const id = item?.id;
  const name = text(item?.title ?? item?.name);
  if (typeof id !== "string" || !ARTIST_ID.test(id) || !name) return null;
  return { id, name, info: text(item.subtitle), ...imagesOf(item) };
}

/**
 * The carousels of an artist page other than its releases, told apart by what they hold (titles are translated).
 * Podcasts, episodes and anything else are left out.
 */
export function artistShelves(sections: any[]): ArtistShelf[] {
  const shelves: ArtistShelf[] = [];
  for (const s of sections ?? []) {
    if (s?.type !== "MusicCarouselShelf") continue;
    const items = itemsOf(s);
    const title = text(s.header?.title);
    if (!items.length || !title) continue;
    const types = new Set(items.map((i: any) => i?.item_type));
    const only = (t: string) => types.size === 1 && types.has(t);
    if (only("album")) continue;
    if (only("playlist")) {
      const playlists = items.map(playlistCard).filter((p): p is PlaylistCard => !!p);
      if (playlists.length) shelves.push({ kind: "playlists", title, playlists });
    } else if (only("artist")) {
      const artists = items.map(artistCard).filter((a): a is ArtistCard => !!a);
      if (artists.length) shelves.push({ kind: "artists", title, artists });
    } else if ([...types].every((t) => t === "video" || t === "song")) {
      const tracks = items.map(videoTrack).filter((t): t is Track => !!t);
      if (tracks.length) shelves.push({ kind: "videos", title, tracks });
    }
  }
  return shelves;
}

const artistPage = cached(30 * MINUTE, async (key): Promise<ArtistPage> => {
  const { lang, id } = parseKey(key);
  const page = await withClient((yt) => yt.music.getArtist(id), lang).catch(() => {
    throw new HttpError(502, msg("artistUnavailable"));
  });
  const header: any = page.header;
  const shelf: any = page.sections.find((s) => s.type === "MusicShelf");
  // Album shelves are told apart by what they hold, not by their (translated) titles: albums come first, then singles.
  const releaseShelves: any[] = page.sections.filter((s: any) => itemsOf(s).some((i) => i.item_type === "album"));
  let items: any[] = itemsOf(shelf);
  // The shelf shows 5; its "show all" link is a playlist with the full ranking.
  const fullList = shelf?.endpoint?.payload?.browseId;
  const [more, albums] = await Promise.all([
    typeof fullList === "string" && fullList.startsWith("VL") ? playlistItems(fullList, MAX_HITS * 2, lang) : Promise.resolve([]),
    releaseShelves[0] ? allAlbums(releaseShelves[0], lang) : Promise.resolve([]),
  ]);
  if (more.length) items = more;
  const banner = (header?.thumbnail?.contents ?? header?.thumbnail ?? [])[0]?.url;
  const name = text(header?.title);
  const tracks = byPlays(
    uniqueTracks(
      items.map((i) => {
        const track = toTrack(i, "song");
        const plays = playsOf(i);
        return track && plays ? { ...track, plays } : track;
      }),
    ),
  ).slice(0, MAX_HITS);
  if (!name && !tracks.length) throw new HttpError(404, msg("artistNotFound"));
  return {
    id,
    name,
    description: text(header?.description),
    banner: typeof banner === "string" && banner.startsWith("https://") ? banner : "",
    tracks,
    albums,
    singles: releaseShelves[1] ? albumCards(itemsOf(releaseShelves[1])) : [],
    shelves: artistShelves(page.sections),
  };
});

export const artist = (id: string, lang: Lang) => artistPage(keyOf(lang, id));

/** An album's tracks in order. Its tracks carry no cover or artist of their own: they get the album's. */
const albumPage = cached(60 * MINUTE, async (key): Promise<AlbumPage> => {
  const { lang, id } = parseKey(key);
  const album: any = await withClient((yt) => yt.music.getAlbum(id), lang).catch(() => {
    throw new HttpError(502, msg("albumUnavailable"));
  });
  const header = album.header;
  const title = text(header?.title);
  const artistRuns: any[] = header?.strapline_text_one?.runs ?? [];
  const artist = text(header?.strapline_text_one) || text(header?.author?.name);
  const artistId: string | null = artistRuns.map((r) => r?.endpoint?.payload?.browseId).find((b) => ARTIST_ID.test(b ?? "")) ?? null;
  const cover = imagesOf(header);
  const tracks = (album.contents ?? [])
    .filter((i: any) => typeof i?.id === "string" && VIDEO_ID.test(i.id))
    .map(
      (i: any): Track => ({
        id: i.id,
        title: text(i.title) || "Untitled",
        artist: (i.artists ?? []).map((a: { name?: string }) => text(a?.name)).filter(Boolean).join(", ") || artist,
        album: title,
        artistId: artistIdOf(i.artists) ?? artistId ?? undefined,
        albumId: id,
        duration: i.duration?.seconds ?? 0,
        thumb: sized(cover.art, 120),
        art: cover.art,
        kind: "song",
      }),
    );
  if (!title && !tracks.length) throw new HttpError(404, msg("albumNotFound"));
  const playlistId = /[?&]list=(OLAK5uy_[\w-]{10,60})/.exec(String(album.url ?? ""))?.[1];
  return {
    id,
    title,
    artist,
    artistId,
    kind: text(header?.subtitle),
    info: text(header?.second_subtitle),
    thumb: cover.thumb,
    art: cover.art,
    tracks,
    ...(playlistId ? { playlistId } : {}),
  };
});

export const album = (id: string, lang: Lang) => albumPage(keyOf(lang, id));

/**
 * The albums in a search response, from every shelf, each once. The album shelf isn't always the first section:
 * a "did you mean" or "showing results for" box, or a top-result card, can come before it.
 */
export function albumResults(result: any): AlbumCard[] {
  const seen = new Set<string>();
  const items = (Array.isArray(result?.contents) ? result.contents : []).flatMap(itemsOf);
  return albumCards(items).filter((a) => !seen.has(a.id) && !!seen.add(a.id));
}

export async function searchAlbums(query: string, lang: Lang): Promise<AlbumCard[]> {
  return albumResults(await withClient((yt) => yt.music.search(query, { type: "album" }), lang));
}

/** The artists in a search response, from every shelf, each once. */
export function artistCards(result: any): ArtistCard[] {
  const seen = new Set<string>();
  const cards: ArtistCard[] = [];
  for (const item of (Array.isArray(result?.contents) ? result.contents : []).flatMap(itemsOf)) {
    const id = item?.id;
    if (item?.item_type !== "artist" || typeof id !== "string" || !ARTIST_ID.test(id) || seen.has(id)) continue;
    const name = text(item.name);
    if (!name) continue;
    seen.add(id);
    cards.push({ id, name, info: text(item.subtitle), ...imagesOf(item) });
  }
  return cards;
}

export async function searchArtists(query: string, lang: Lang): Promise<ArtistCard[]> {
  return artistCards(await withClient((yt) => yt.music.search(query, { type: "artist" }), lang));
}

/** The playlists in a search response, from every shelf, each once. */
export function playlistResults(result: any): PlaylistCard[] {
  const seen = new Set<string>();
  const cards: PlaylistCard[] = [];
  for (const item of (Array.isArray(result?.contents) ? result.contents : []).flatMap(itemsOf)) {
    const id = item?.id;
    if (item?.item_type !== "playlist" || typeof id !== "string" || !YT_PLAYLIST_ID.test(id) || seen.has(id)) continue;
    const title = text(item.title);
    if (!title) continue;
    seen.add(id);
    // youtubei.js gives playlists no subtitle of their own: it's the row's second column.
    cards.push({ id, title, info: text(item.subtitle) || text(item.flex_columns?.[1]?.title), ...imagesOf(item) });
  }
  return cards;
}

export async function searchPlaylists(query: string, lang: Lang): Promise<PlaylistCard[]> {
  return playlistResults(await withClient((yt) => yt.music.search(query, { type: "playlist" }), lang));
}

/** A playlist's header and tracks, as YouTube Music lists them (songs and videos alike). */
export function ytPlaylistOf(id: string, list: any): YtPlaylistPage {
  const header = list?.header;
  const items: any[] = (list?.items ?? list?.contents ?? []).slice(0, MAX_PLAYLIST_TRACKS);
  const tracks = uniqueTracks(items.map((i) => toTrack(i, i?.item_type === "video" ? "video" : "song")));
  const title = text(header?.title);
  if (!title && !tracks.length) throw new HttpError(404, msg("playlistNotFound"));
  return {
    id,
    title,
    author: text(header?.strapline_text_one) || text(header?.author?.name),
    info: text(header?.second_subtitle) || text(header?.subtitle),
    description: text(header?.description?.description ?? header?.description),
    ...imagesOf(header),
    tracks,
  };
}

const ytPlaylistPage = cached(30 * MINUTE, async (key): Promise<YtPlaylistPage> => {
  const { lang, id } = parseKey(key);
  const list = await withClient((yt) => yt.music.getPlaylist(id), lang).catch(() => {
    throw new HttpError(502, msg("ytPlaylistUnavailable"));
  });
  return ytPlaylistOf(id, list);
});

export const ytPlaylist = (id: string, lang: Lang) => ytPlaylistPage(keyOf(lang, id));

// ---- Discover (Home) -------------------------------------------------------------------------------------------
// From Ernani1234/musike#54: the catalog's own picks on Home, for an empty library most of all.

export type HomeSection =
  | { title: string; kind: "tracks"; items: Track[] }
  | { title: string; kind: "albums"; items: AlbumCard[] }
  | { title: string; kind: "playlists"; items: PlaylistCard[] }
  | { title: string; kind: "artists"; items: ArtistCard[] };

export interface HomeFeed {
  sections: HomeSection[];
}

/** "Top artists" (charts): a plain list row, unlike the typed cards of song and playlist shelves. */
function chartArtist(item: any): ArtistCard | null {
  const id = item?.endpoint?.payload?.browseId;
  const name = text(item?.flex_columns?.[0]?.title);
  if (!ARTIST_ID.test(id ?? "") || !name) return null;
  return { id, name, info: text(item?.flex_columns?.[1]?.title), ...imagesOf(item) };
}

/** YouTube Music's own code for the "Global" scope of its charts (its country menu sends this literal). */
const WORLD_CHART = "ZZ";

/** "IT" -> "Italia" in the request's language; "ZZ" -> a translated "World". */
function regionName(code: string, lang: Lang): string {
  if (code === WORLD_CHART) return tr(lang, msg("worldRegion"));
  try {
    return new Intl.DisplayNames(youtubeLang(lang), { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * The charts page for one country (or "ZZ"). Guest sessions get "Top artists" and "Video charts"; the per-song
 * chart comes back empty without a signed-in session.
 */
async function chartShelves(code: string, lang: Lang): Promise<{ artists: any; videos: any }> {
  const page = await withClient((yt) => browse(yt, { browseId: "FEmusic_charts", formData: { selectedValues: [code] } }), lang).catch(
    () => null,
  );
  const shelves = page ? shelvesOf(page) : [];
  return {
    artists: shelves.find((sh) => itemsOf(sh).some((i: any) => i.item_type === "artist")),
    videos: shelves.find((sh) => itemsOf(sh).some((i: any) => i.item_type === "playlist")),
  };
}

const MAX_HOME_TRACKS = 25;
const MAX_NEW_RELEASES = 30;
/** How many moods get their own Home shelf (all of them are in Search). */
const MOOD_HOME_SHELVES = 3;
const MAX_MOOD_TRACKS = 40;

/** The first few moods' tracks, each its own shelf, in YouTube Music's order (names come in the app language). */
async function moodSections(lang: Lang): Promise<HomeSection[]> {
  const picked = (await moods(lang).catch(() => [] as Genre[])).slice(0, MOOD_HOME_SHELVES);
  const pages = await Promise.all(picked.map((m) => genre(m.id, lang).catch(() => null)));
  const sections: HomeSection[] = [];
  for (const [i, page] of pages.entries()) {
    if (page?.tracks.length) sections.push({ title: picked[i]!.name, kind: "tracks", items: page.tracks.slice(0, MAX_MOOD_TRACKS) });
  }
  return sections;
}

/**
 * The catalog's own picks, the same for everyone (no sign-in to YouTube, nothing personal): the guest home feed
 * (quick picks, curated playlists), new albums, a few moods, and the charts (top artists, video charts) for the
 * server's region (MUSIKE_LOCATION) and the world. Each source fails on its own: only its shelf goes missing.
 */
const homeFeed = cached(15 * MINUTE, async (lang): Promise<HomeFeed> => {
  const l = lang as Lang;
  const sections: HomeSection[] = [];
  const [homePage, releasesPage, ownCharts, worldCharts, moodShelves] = await Promise.all([
    withClient((yt) => browse(yt, { browseId: "FEmusic_home" }), l).catch(() => null),
    withClient((yt) => browse(yt, { browseId: "FEmusic_new_releases_albums" }), l).catch(() => null),
    chartShelves(config.location, l),
    chartShelves(WORLD_CHART, l),
    moodSections(l).catch(() => [] as HomeSection[]),
  ]);

  for (const shelf of homePage ? shelvesOf(homePage) : []) {
    const title = text(shelf?.header?.title ?? shelf?.title);
    const items = itemsOf(shelf);
    if (!title || !items.length) continue;
    if (items[0]?.item_type === "song") {
      const tracks = uniqueTracks(items.map((i: any) => toTrack(i, "song"))).slice(0, MAX_HOME_TRACKS);
      if (tracks.length) sections.push({ title, kind: "tracks", items: tracks });
    } else if (items[0]?.item_type === "playlist") {
      const cards = items.map(playlistCard).filter((c: PlaylistCard | null): c is PlaylistCard => !!c);
      if (cards.length) sections.push({ title, kind: "playlists", items: cards });
    }
  }

  if (releasesPage) {
    const cards = itemsOf(shelvesOf(releasesPage)[0])
      .map(albumCard)
      .filter((c: AlbumCard | null): c is AlbumCard => !!c)
      .slice(0, MAX_NEW_RELEASES);
    if (cards.length) sections.push({ title: tr(l, msg("newReleasesTitle")), kind: "albums", items: cards });
  }

  sections.push(...moodShelves);

  // YouTube's own titles ("Top artists", "Video charts") say what the chart is, not where: the region is added.
  for (const [code, charts] of [
    [config.location, ownCharts],
    [WORLD_CHART, worldCharts],
  ] as const) {
    const region = regionName(code, l);
    if (charts.artists) {
      const base = text(charts.artists.header?.title ?? charts.artists.title);
      const cards = itemsOf(charts.artists).map(chartArtist).filter((c: ArtistCard | null): c is ArtistCard => !!c);
      if (base && cards.length) sections.push({ title: `${base} · ${region}`, kind: "artists", items: cards });
    }
    if (charts.videos) {
      const base = text(charts.videos.header?.title ?? charts.videos.title);
      const cards = itemsOf(charts.videos).map(playlistCard).filter((c: PlaylistCard | null): c is PlaylistCard => !!c);
      if (base && cards.length) sections.push({ title: `${base} · ${region}`, kind: "playlists", items: cards });
    }
  }
  return { sections };
});

export const home = (lang: Lang) => homeFeed(lang);

// ---- Weekly Mix -------------------------------------------------------------------------------------------------

/** What a Weekly Mix is made from: one person's library and their recent plays (most played first). */
export interface MixSource {
  favorites: Track[];
  history: Track[];
  /** Played in the last weeks, most played first. */
  top: Track[];
}

const MIX_SEEDS = 6;
const MAX_MIX = 40;

function sample<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}

/** Monday of this week (UTC), as a key: the mix is the same all week, a new one on Monday. */
export function weekOf(now = Date.now()): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const mixes = new Map<string, Promise<HomeSection | null>>();

/**
 * A Weekly Mix for one person (`who`: their account): the radio of a few seeds, interleaved, minus everything they
 * already have or played. Half the seeds are their most played of the last weeks, half picked at random from their
 * favorites and history, so the mix follows what they listen to now without always the same few songs. Kept for
 * the week; null with nothing to start from.
 */
export function weeklyMix(who: string, source: MixSource, lang: Lang, radioOf = radio): Promise<HomeSection | null> {
  const key = `${who}|${weekOf()}|${lang}`;
  const hit = mixes.get(key);
  if (hit) return hit;
  const made = (async (): Promise<HomeSection | null> => {
    const known = new Set([...source.favorites, ...source.history, ...source.top].map((t) => t.id));
    if (!known.size) return null;
    const top = source.top.slice(0, MIX_SEEDS * 2);
    const fromTop = sample(top, Math.min(MIX_SEEDS / 2, top.length));
    const taken = new Set(fromTop.map((t) => t.id));
    const pool = [...source.favorites, ...source.history].filter((t) => !taken.has(t.id));
    const seeds = [...fromTop, ...sample(pool, MIX_SEEDS - fromTop.length)];
    const lists = await Promise.all(seeds.map((t) => radioOf(t.id).catch(() => [] as Track[])));
    const tracks = uniqueTracks(roundRobin(lists).filter((t) => !known.has(t.id))).slice(0, MAX_MIX);
    if (!tracks.length) throw new Error("no mix tracks"); // not kept: tried again next time
    return { title: tr(lang, msg("weeklyMixTitle")), kind: "tracks", items: tracks };
  })();
  mixes.set(key, made);
  made.catch(() => mixes.get(key) === made && mixes.delete(key));
  // Last week's mixes go.
  for (const k of mixes.keys()) if (!k.includes(`|${weekOf()}|`)) mixes.delete(k);
  return made;
}
