export interface Track {
  id: string;
  title: string;
  artist: string;
  album?: string;
  /** YouTube Music channel of the main artist, when known: opens their artist page. */
  artistId?: string;
  /** YouTube Music album the track belongs to, when known: opens the album page. */
  albumId?: string;
  /** YouTube Music's play count as it words it ("235M plays"), on an artist's top songs. Not saved. */
  plays?: string;
  duration: number;
  thumb: string;
  art: string;
  kind: "song" | "video";
}

export interface Playlist {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  tracks: Track[];
  /** A radio playlist not saved yet (server/src/types.ts RadioInfo); absent on a playlist of yours. */
  radio?: RadioInfo;
}

/** The radio playlist's state: what it started from, the tracks kept and taken out, changed since it was made. */
export interface RadioInfo {
  seed: string;
  kept: string[];
  discarded: string[];
  edited: boolean;
}

/** A change to a radio playlist: any of these. */
export interface RadioPatch {
  tracks?: Track[];
  kept?: string[];
  discarded?: string[];
}

/** An artist kept in the library. */
export interface SavedArtist {
  id: string;
  name: string;
  thumb: string;
  art: string;
  savedAt: number;
}

/** An album kept in the library. */
export interface SavedAlbum {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  year: string;
  thumb: string;
  art: string;
  savedAt: number;
}

/** A YouTube Music playlist as a search result. */
export interface PlaylistCard {
  id: string;
  title: string;
  /** YouTube Music's own line, already in the app language: "Playlist • Someone • 1.2M views". */
  info: string;
  thumb: string;
  art: string;
}

/** A YouTube Music playlist and its tracks. */
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

/** A YouTube Music playlist kept in the library: a link, it shows whatever the playlist holds when opened. */
export interface SavedYtPlaylist {
  id: string;
  title: string;
  author: string;
  thumb: string;
  art: string;
  savedAt: number;
}

/**
 * Something you searched for, opened or played, for the Search page's "Recent" list: a search, a track, an artist,
 * an album or a YouTube Music playlist. Newest first; one entry per thing (opening it again moves it on top).
 */
export type RecentItem =
  | { kind: "query"; id: string; q: string; at: number }
  | { kind: "track"; id: string; track: Track; at: number }
  | { kind: "artist"; id: string; name: string; thumb: string; at: number }
  | { kind: "album"; id: string; title: string; artist: string; artistId?: string; thumb: string; at: number }
  | { kind: "playlist"; id: string; title: string; author: string; thumb: string; at: number };

/** What the app sends to add one: the server sets the id and the time. */
export type RecentInput =
  | { kind: "query"; q: string }
  | { kind: "track"; track: Track }
  | { kind: "artist"; id: string; name: string; thumb: string }
  | { kind: "album"; id: string; title: string; artist: string; artistId?: string; thumb: string }
  | { kind: "playlist"; id: string; title: string; author: string; thumb: string };

export type RecentKind = RecentItem["kind"];

/** How often a track was played here, and when last. */
export interface PlayEntry {
  track: Track;
  count: number;
  lastPlayed: number;
}

export interface Library {
  favorites: Track[];
  playlists: Playlist[];
  history: Track[];
  /** Newest first. */
  artists: SavedArtist[];
  albums: SavedAlbum[];
  ytPlaylists: SavedYtPlaylist[];
  /** Only in backups: the server sends the play log on its own (api.plays). */
  plays?: PlayEntry[];
}

export interface Genre {
  id: string;
  name: string;
}

export interface GenreArtist {
  id: string;
  name: string;
  /** Cover of one of their releases in the genre. */
  thumb: string;
  art: string;
  /** A few of their songs in the genre. */
  hits: string[];
}

export interface GenrePage {
  id: string;
  name: string;
  /** First page of artists; `api.genreArtists` brings the next ones. */
  artists: GenreArtist[];
  hasMoreArtists: boolean;
  tracks: Track[];
}

/** An album or single as a cover in a list. */
export interface AlbumCard {
  id: string;
  title: string;
  /** Empty on an artist's own page. */
  artist: string;
  year: string;
  thumb: string;
  art: string;
}

/** An artist as a search result. */
export interface ArtistCard {
  id: string;
  name: string;
  /** YouTube Music's own line, already in the app language: "Artist • 1.2M subscribers". */
  info: string;
  thumb: string;
  art: string;
}

export interface ArtistPage {
  id: string;
  name: string;
  description: string;
  banner: string;
  /** Top songs, most played first. */
  tracks: Track[];
  albums: AlbumCard[];
  singles: AlbumCard[];
  /** The page's other shelves, in YouTube Music's order and with its titles. Missing from older servers. */
  shelves?: ArtistShelf[];
}

/** A shelf of an artist page: videos (live performances too), playlists or artists. */
export type ArtistShelf =
  | { kind: "videos"; title: string; tracks: Track[] }
  | { kind: "playlists"; title: string; playlists: PlaylistCard[] }
  | { kind: "artists"; title: string; artists: ArtistCard[] };

/** A Discover shelf on Home (Ernani1234/musike#54): YouTube Music's picks, or this person's Weekly Mix. */
export type HomeSection =
  | { title: string; kind: "tracks"; items: Track[] }
  | { title: string; kind: "albums"; items: AlbumCard[] }
  | { title: string; kind: "playlists"; items: PlaylistCard[] }
  | { title: string; kind: "artists"; items: ArtistCard[] };

export interface HomeFeed {
  sections: HomeSection[];
}

/** The profile's "You might also like" and the live performances its artists' pages list. */
export interface Discover {
  artists: ArtistCard[];
  live: string[];
}

export interface AlbumPage {
  id: string;
  title: string;
  artist: string;
  artistId: string | null;
  /** YouTube Music's own lines, already in the app language: "Album • 1991", "13 songs • 49 minutes". */
  kind: string;
  info: string;
  thumb: string;
  art: string;
  tracks: Track[];
  /** The album as a playlist (OLAK5uy_...): its address on YouTube. Missing from older servers. */
  playlistId?: string;
}
