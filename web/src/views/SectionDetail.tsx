import { PauseIcon, PlayIcon, PlusIcon, ShuffleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { AlbumGrid } from "../components/AlbumTiles";
import { ArtistGrid } from "../components/ArtistTiles";
import { IconButton, PlayDisc } from "../components/IconButton";
import { BackButton, PageHeader } from "../components/Page";
import { SelectableTrackList } from "../components/Selection";
import { useT } from "../i18n";
import { shuffled } from "../lib/format";
import { paths } from "../lib/routes";
import type { HomeSection } from "../lib/types";
import { usePlayer } from "../player/player";
import { useLibrary } from "../stores/library";

/**
 * A Discover shelf from Home in full (a chart, the Weekly Mix, a mood). From Ernani1234/musike#54: the items come
 * with the link (route state), already in memory, so nothing is fetched again; reloaded, it goes back to Home.
 */
export default function SectionDetail() {
  const location = useLocation();
  const navigate = useNavigate();
  const t = useT();
  const section = (location.state as { section?: HomeSection } | null)?.section;
  const playList = usePlayer((s) => s.playList);
  const toggle = usePlayer((s) => s.toggle);
  const queue = usePlayer((s) => s.queue);
  const status = usePlayer((s) => s.status);
  const createPlaylist = useLibrary((s) => s.createPlaylist);
  const [saving, setSaving] = useState(false);

  if (!section) return <Navigate to={paths.home} replace />;

  const tracks = section.kind === "tracks" ? section.items : [];
  const isThisPlaying = tracks.length > 0 && queue.length === tracks.length && queue.every((q, i) => q.id === tracks[i]?.id);
  const playing = isThisPlaying && (status === "playing" || status === "loading");

  return (
    <div className="pb-8">
      <PageHeader title={section.title} actions={<BackButton fallback={paths.home} />} />

      {tracks.length > 0 && (
        <div className="flex items-center gap-2 px-4 pt-2 pb-4 md:px-6">
          <PlayDisc label={playing ? t.common.pause : t.common.playAll} px={56} onClick={() => (isThisPlaying ? toggle() : playList(tracks, 0))}>
            {playing ? <PauseIcon size={24} weight="fill" /> : <PlayIcon size={24} weight="fill" />}
          </PlayDisc>
          <IconButton label={t.album.shuffle} size="lg" onClick={() => playList(shuffled(tracks), 0)}>
            <ShuffleIcon size={24} />
          </IconButton>
          {/* A shelf only lives on Home (the Weekly Mix changes every week): kept as a playlist of your own. */}
          <button
            type="button"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              const p = await createPlaylist(section.title, tracks);
              setSaving(false);
              if (p) navigate(paths.playlist(p.id));
            }}
            className="ml-1 flex h-10 items-center gap-2 rounded-full px-4 text-sm font-medium ring-1 ring-line transition-colors hover:bg-surface-3 disabled:opacity-50"
          >
            <PlusIcon size={18} /> {t.home.saveAsPlaylist}
          </button>
        </div>
      )}

      {section.kind === "tracks" && <SelectableTrackList tracks={section.items} numbered />}
      {section.kind === "albums" && <AlbumGrid albums={section.items} />}
      {section.kind === "artists" && <ArtistGrid artists={section.items} />}
    </div>
  );
}
