import { ClockCounterClockwiseIcon, HeartIcon, MagnifyingGlassIcon, PlayIcon } from "@phosphor-icons/react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { Artwork } from "../components/Artwork";
import { LogoMark } from "../components/Brand";
import { PageHeader, Section } from "../components/Page";
import { PlaylistRow } from "../components/PlaylistTiles";
import { ROW_CLASS, RowArrows, useRowScroll } from "../components/ScrollRow";
import { TrackList, TrackListSkeleton } from "../components/TrackList";
import { useRemote } from "../hooks/useRemote";
import { useI18n, useT } from "../i18n";
import { api } from "../lib/api";
import { paths } from "../lib/routes";
import type { HomeFeed, HomeSection, Track } from "../lib/types";
import { usePlayer } from "../player/player";
import { useAppearance } from "../stores/appearance";
import { useAuth } from "../stores/auth";
import { useLibrary } from "../stores/library";

function Shortcut({ to, label, tracks, cover }: { to: string; label: string; tracks: Track[]; cover: ReactNode }) {
  const playList = usePlayer((s) => s.playList);
  const t = useT();
  return (
    <div className="group relative flex h-14 items-center gap-3 overflow-hidden rounded-[12px] bg-surface-2 pr-2 transition-colors hover:bg-surface-3 md:h-16">
      <Link to={to} className="absolute inset-0" aria-label={label} />
      <span className="pointer-events-none size-14 shrink-0 overflow-hidden md:size-16">{cover}</span>
      <span className="pointer-events-none min-w-0 flex-1 truncate text-[13px] font-semibold md:text-sm">{label}</span>
      {tracks.length > 0 && (
        <button
          type="button"
          onClick={() => playList(tracks, 0)}
          aria-label={t.common.playX(label)}
          className="relative z-10 hidden size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-ink opacity-0 shadow-[0_6px_18px_rgb(0_0_0/0.35)] transition-[opacity,transform] duration-200 ease-out-expo group-hover:opacity-100 hover:scale-105 active:scale-95 md:grid"
        >
          <PlayIcon size={18} weight="fill" />
        </button>
      )}
    </div>
  );
}

function RecentCard({ track, onPlay }: { track: Track; onPlay: () => void }) {
  return (
    <button type="button" onClick={onPlay} className="group flex w-36 shrink-0 snap-start flex-col gap-2 text-left md:w-44">
      <span className="relative block">
        <Artwork src={track.art} fallback={track.thumb} className="aspect-square w-full rounded-[14px]" />
        <span className="absolute right-2 bottom-2 grid size-11 translate-y-1 place-items-center rounded-full bg-accent text-accent-ink opacity-0 shadow-[0_8px_20px_rgb(0_0_0/0.4)] transition-[opacity,transform] duration-200 ease-out-expo group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:opacity-100">
          <PlayIcon size={20} weight="fill" />
        </span>
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{track.title}</span>
        <span className="block truncate text-xs text-fg-2">{track.artist}</span>
      </span>
    </button>
  );
}

/**
 * A row that snaps to its cards keeps the card it was on when one is added in front: the new first card would be
 * scrolled out of view, to the left. Back to the start whenever the first card changes.
 */
function useStartOnNewFirst(first: string | undefined) {
  const row = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    row.current?.scrollTo({ left: 0 });
  }, [first]);
  return row;
}

/** A shelf heavy enough (a chart, a mix: 40 items) to open on a page of its own, from one tile. */
type TileSection = HomeSection & { kind: "tracks" | "albums" | "artists" };

/** One tile for a whole shelf: opens SectionDetail with its items (carried in the link, not fetched again). */
function SectionTile({ section, mix = false }: { section: TileSection; mix?: boolean }) {
  const t = useT();
  const first = section.items[0] as { art?: string; thumb?: string } | undefined;
  const n = section.items.length;
  const count = section.kind === "tracks" ? t.common.songs(n) : section.kind === "albums" ? t.common.albums(n) : t.common.artists(n);
  return (
    <Link to={paths.section} state={{ section }} className="group flex flex-col gap-2">
      <span className="relative block overflow-hidden rounded-[14px]">
        <Artwork
          src={first?.art}
          fallback={first?.thumb}
          className="aspect-square w-full transition-transform duration-300 ease-out-expo group-hover:scale-[1.04]"
        />
        {mix && (
          <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-3 pt-8 pb-2.5 text-sm font-semibold text-white">
            {t.home.forYou}
          </span>
        )}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold">{section.title}</span>
        <span className="block truncate text-xs text-fg-2">{count}</span>
      </span>
    </Link>
  );
}

/**
 * Discover (from Ernani1234/musike#54): this person's Weekly Mix, then YouTube Music's picks: charts, new albums,
 * moods as tiles in one row; curated playlists and video charts as rows of covers. Each source fails on its own.
 */
function DiscoverSections() {
  const lang = useI18n((s) => s.lang);
  const t = useT();
  const feed = useRemote<HomeFeed>(`home:${lang}`, (signal) => api.home(signal));
  const mix = useRemote<HomeSection | null>(`weekly-mix:${lang}`, (signal) => api.weeklyMix(signal));
  const weekly = mix.status === "ok" && mix.data?.kind === "tracks" && mix.data.items.length ? (mix.data as TileSection) : null;

  if (feed.status === "loading" && !weekly) {
    return (
      <div className="flex flex-col gap-3">
        <h2 className="px-4 text-xl font-semibold tracking-tight md:px-6">{t.home.discover}</h2>
        <div className="no-scrollbar flex gap-4 overflow-x-auto px-4 md:px-6">
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className="skeleton aspect-square w-36 shrink-0 rounded-[14px] md:w-44" />
          ))}
        </div>
      </div>
    );
  }

  const sections = feed.status === "ok" ? feed.data.sections : [];
  const tiles = sections.filter((s): s is TileSection => s.kind !== "playlists");
  const rows = sections.filter((s): s is HomeSection & { kind: "playlists" } => s.kind === "playlists");

  return (
    <>
      {(weekly || tiles.length > 0) && (
        <Section title={t.home.discover}>
          <ul className="no-scrollbar flex snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 md:scroll-px-6 md:px-6">
            {weekly && (
              <li className="w-36 shrink-0 snap-start md:w-44">
                <SectionTile section={weekly} mix />
              </li>
            )}
            {tiles.map((section, i) => (
              <li key={`${section.kind}:${i}`} className="w-36 shrink-0 snap-start md:w-44">
                <SectionTile section={section} />
              </li>
            ))}
          </ul>
        </Section>
      )}
      {feed.status === "error" && (
        <p className="flex items-center gap-3 px-4 text-sm text-fg-2 md:px-6">
          {feed.message}
          <button type="button" onClick={feed.retry} className="font-medium text-fg underline-offset-2 hover:underline">
            {t.common.retry}
          </button>
        </p>
      )}
      {rows.map((section, i) => (
        <PlaylistRow key={`${section.title}:${i}`} title={section.title} playlists={section.items} />
      ))}
    </>
  );
}

export default function Home() {
  const { favorites, playlists, history, status } = useLibrary();
  const recentRow = useRowScroll(useStartOnNewFirst(history[0]?.id));
  const playList = usePlayer((s) => s.playList);
  const navigate = useNavigate();
  const t = useT();
  const show = useAppearance();
  const empty = status === "ready" && !favorites.length && !playlists.length && !history.length;
  // "Good evening, Ava": the name set in Settings, else the account's; on the phone on its own, none unless set.
  const account = useAuth((s) => s.user?.username ?? "");
  const name = show.greetName || account;
  const hello = t.time.greeting(new Date().getHours());
  const greeting = name ? t.time.greetingName(hello, name) : hello;

  return (
    <div className="pb-8">
      <PageHeader />

      <div className="px-4 pt-2 pb-6 md:px-6 md:pt-8">
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight md:text-4xl">{greeting}</h1>
      </div>

      {status === "loading" && <TrackListSkeleton rows={6} />}

      {empty && (
        <div className="mx-4 flex flex-col items-start gap-5 rounded-[20px] bg-surface-2 p-6 ring-1 ring-line md:mx-6 md:flex-row md:items-center md:p-8">
          <span className="grid size-16 shrink-0 place-items-center rounded-[18px] bg-accent text-accent-ink">
            <LogoMark className="size-10" />
          </span>
          <div className="flex-1">
            <p className="text-xl font-semibold tracking-tight">{t.home.startTitle}</p>
            <p className="mt-1 max-w-[52ch] text-sm text-fg-2">{t.home.startBody}</p>
          </div>
          <button
            type="button"
            onClick={() => navigate(paths.search)}
            className="flex h-12 items-center gap-2 rounded-full bg-accent pr-6 pl-5 font-semibold text-accent-ink transition-transform active:scale-[0.97]"
          >
            <MagnifyingGlassIcon size={20} weight="bold" /> {t.common.searchMusic}
          </button>
        </div>
      )}

      {/* A new library has nothing of its own to show: what to discover comes right after the welcome. */}
      {empty && show.homeDiscover && (
        <div className="flex flex-col gap-10 pt-8">
          <DiscoverSections />
        </div>
      )}

      {!empty && status === "ready" && (
        <div className="flex flex-col gap-10">
          {show.homeShortcuts && <div className="grid grid-cols-2 gap-2 px-4 md:px-6 lg:grid-cols-3 2xl:grid-cols-4">
            <Shortcut
              to={paths.favorites}
              label={t.nav.favorites}
              tracks={favorites}
              cover={
                <span className="grid size-full place-items-center bg-accent-soft text-accent-text">
                  <HeartIcon size={24} weight="fill" />
                </span>
              }
            />
            <Shortcut
              to={paths.history}
              label={t.nav.recentlyPlayed}
              tracks={history}
              cover={
                <span className="grid size-full place-items-center bg-surface-3 text-fg-2">
                  <ClockCounterClockwiseIcon size={24} />
                </span>
              }
            />
            {playlists.slice(0, 6).map((p) => (
              <Shortcut
                key={p.id}
                to={paths.playlist(p.id)}
                label={p.name}
                tracks={p.tracks}
                cover={<Artwork src={p.tracks[0]?.thumb} className="size-full" />}
              />
            ))}
          </div>}

          {show.homeRecent && history.length > 0 && (
            <Section
              title={t.nav.recentlyPlayed}
              action={
                <div className="flex items-center gap-3">
                  <RowArrows row={recentRow} />
                  <Link to={paths.history} className="text-sm font-medium text-fg-2 hover:text-fg">
                    {t.home.seeAll}
                  </Link>
                </div>
              }
            >
              <div ref={recentRow.ref} className={ROW_CLASS}>
                {history.slice(0, 16).map((t, i) => (
                  <RecentCard key={t.id} track={t} onPlay={() => playList(history, i)} />
                ))}
              </div>
            </Section>
          )}

          {show.homeDiscover && <DiscoverSections />}

          {show.homeFavorites && favorites.length > 0 && (
            <Section
              title={t.home.yourFavorites}
              action={
                <Link to={paths.favorites} className="text-sm font-medium text-fg-2 hover:text-fg">
                  {t.home.seeAll}
                </Link>
              }
            >
              <div className="px-2 md:px-3">
                <TrackList tracks={favorites.slice(0, 5)} context={favorites} header={false} showAlbum={false} />
              </div>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
