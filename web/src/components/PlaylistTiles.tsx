import { Link } from "react-router";
import { paths } from "../lib/routes";
import type { PlaylistCard } from "../lib/types";
import { DENSE_GRID } from "./AlbumTiles";
import { Artwork } from "./Artwork";
import { ScrollRow } from "./ScrollRow";

/** A YouTube Music playlist's cover and title; opens the playlist (Play, Shuffle, Save as playlist). */
export function PlaylistTile({ playlist: p }: { playlist: PlaylistCard }) {
  return (
    <Link to={paths.ytPlaylist(p.id)} state={{ name: p.title }} className="group flex flex-col gap-2">
      <span className="block overflow-hidden rounded-xl">
        <Artwork
          src={p.art}
          fallback={p.thumb}
          className="aspect-square w-full rounded-xl transition-transform duration-300 ease-out-expo group-hover:scale-[1.04]"
        />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold">{p.title}</span>
        {p.info && <span className="line-clamp-2 text-xs text-fg-2">{p.info}</span>}
      </span>
    </Link>
  );
}

/** YouTube Music playlists as a grid of covers; each opens the playlist. `dense` as in AlbumGrid. */
export function PlaylistGrid({ playlists, dense = false }: { playlists: PlaylistCard[]; dense?: boolean }) {
  return (
    <ul className={dense ? DENSE_GRID : "grid grid-cols-2 gap-x-3 gap-y-5 px-2 sm:grid-cols-3 md:px-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6"}>
      {playlists.map((p) => (
        <li key={p.id}>
          <PlaylistTile playlist={p} />
        </li>
      ))}
    </ul>
  );
}

/** A titled, horizontally scrolling row of playlists (Home's curated shelves and video charts). */
export function PlaylistRow({ title, playlists }: { title: string; playlists: PlaylistCard[] }) {
  return (
    <ScrollRow title={title}>
      {playlists.map((p) => (
        <li key={p.id} className="w-36 shrink-0 snap-start md:w-44">
          <PlaylistTile playlist={p} />
        </li>
      ))}
    </ScrollRow>
  );
}
