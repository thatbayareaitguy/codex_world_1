"use client";

import {
  type FeedFixtureItem,
  type FeedState,
  type SoundCloudLinkRecord,
  buildSoundCloudSearchUrl,
  validateSoundCloudUrl,
} from "@radar/core";
import {
  BellRing,
  Activity,
  Bookmark,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Disc3,
  ExternalLink,
  Headphones,
  Inbox,
  ListMusic,
  Link2,
  MoreHorizontal,
  Pencil,
  Radio,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

interface RadarShellProps {
  feedMode: "database" | "error" | "mock";
  initialItems: FeedFixtureItem[];
  providerConfiguration: ProviderUiConfiguration;
  scannedItem: FeedFixtureItem;
}

interface ProviderUiConfiguration {
  databaseConfigured: boolean;
  musicbrainz: { configured: boolean; enabled: boolean };
  soundcloudManualLinksEnabled: boolean;
  spotify: { configured: boolean; enabled: boolean };
}

type AppView =
  "feed" | "artists" | "exports" | "soundcloud-links" | "review" | "status" | "settings";
type ArtistSort = "name-asc" | "name-desc" | "recent";
type ThemePreference = "system" | "light" | "dark";

interface FeedAdvancedFilters {
  artist: string;
  dateFrom: string;
  dateTo: string;
  releaseType: string;
  sort: "release" | "first-seen";
  spotify: "all" | "available" | "unavailable";
}

interface WatchedArtist {
  addedAt: number;
  id: string;
  manuallyAdded: boolean;
  name: string;
  releases: FeedFixtureItem[];
}

const filters: Array<{ state: FeedState | "all"; label: string }> = [
  { state: "all", label: "All" },
  { state: "new", label: "New" },
  { state: "upcoming", label: "Upcoming" },
  { state: "saved", label: "Saved" },
  { state: "listened", label: "Listened" },
  { state: "dismissed", label: "Dismissed" },
  { state: "needs_review", label: "Needs review" },
];

const appViews = new Set<AppView>([
  "feed",
  "artists",
  "exports",
  "soundcloud-links",
  "review",
  "status",
  "settings",
]);

export function RadarShell({
  feedMode,
  initialItems,
  providerConfiguration,
  scannedItem,
}: RadarShellProps) {
  const [activeView, setActiveView] = useState<AppView>("feed");
  const [hydrated, setHydrated] = useState(false);
  const [activeFilter, setActiveFilter] = useState<FeedState | "all">("all");
  const [items, setItems] = useState(initialItems);
  const [query, setQuery] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [exactOnly, setExactOnly] = useState(false);
  const [advancedFilters, setAdvancedFilters] = useState<FeedAdvancedFilters>({
    artist: "all",
    dateFrom: "",
    dateTo: "",
    releaseType: "all",
    sort: "release",
    spotify: "all",
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [dailyScan, setDailyScan] = useState(true);
  const [digest, setDigest] = useState(false);
  const [themePreference, setThemePreference] = useState<ThemePreference | null>(null);
  const [addedArtists, setAddedArtists] = useState<WatchedArtist[]>([]);
  const [artistNames, setArtistNames] = useState<Record<string, string>>({});
  const [removedArtistIds, setRemovedArtistIds] = useState<string[]>([]);
  const [artistProfiles, setArtistProfiles] = useState<Record<string, string>>({});
  const [soundCloudLinks, setSoundCloudLinks] = useState<Record<string, SoundCloudLinkRecord>>({});

  useEffect(() => {
    const syncViewFromHash = () => {
      const hash = window.location.hash.slice(1) as AppView;
      setActiveView(
        appViews.has(hash) &&
          (hash !== "soundcloud-links" || providerConfiguration.soundcloudManualLinksEnabled)
          ? hash
          : "feed",
      );
    };

    const frame = window.requestAnimationFrame(() => {
      syncViewFromHash();
      setHydrated(true);
    });
    window.addEventListener("hashchange", syncViewFromHash);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", syncViewFromHash);
    };
  }, [providerConfiguration.soundcloudManualLinksEnabled]);

  useEffect(() => {
    const storedTheme = window.localStorage.getItem("ts-radar-theme");
    setThemePreference(
      storedTheme === "light" || storedTheme === "dark" || storedTheme === "system"
        ? storedTheme
        : "system",
    );
  }, []);

  useEffect(() => {
    if (!themePreference) return;

    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolvedTheme =
        themePreference === "system" ? (systemTheme.matches ? "dark" : "light") : themePreference;
      document.documentElement.dataset.theme = resolvedTheme;
      document.documentElement.style.colorScheme = resolvedTheme;
    };

    window.localStorage.setItem("ts-radar-theme", themePreference);
    applyTheme();
    if (themePreference === "system") systemTheme.addEventListener("change", applyTheme);
    return () => systemTheme.removeEventListener("change", applyTheme);
  }, [themePreference]);

  const visibleItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
    return items
      .filter((item) => {
        const stateMatches = activeFilter === "all" || item.state === activeFilter;
        const queryMatches =
          !normalizedQuery ||
          `${item.artist} ${item.title} ${item.releaseTitle}`
            .toLocaleLowerCase("en-US")
            .includes(normalizedQuery);
        const confidenceMatches = !exactOnly || item.confidence === 1;
        const spotifyMatches =
          advancedFilters.spotify === "all" ||
          (advancedFilters.spotify === "available"
            ? item.spotify === "playable"
            : item.spotify !== "playable");
        const releaseTypeMatches =
          advancedFilters.releaseType === "all" || item.releaseType === advancedFilters.releaseType;
        const artistMatches =
          advancedFilters.artist === "all" || item.artist === advancedFilters.artist;
        const dateMatches =
          (!advancedFilters.dateFrom || item.releaseDate >= advancedFilters.dateFrom) &&
          (!advancedFilters.dateTo || item.releaseDate <= advancedFilters.dateTo);
        return (
          stateMatches &&
          queryMatches &&
          confidenceMatches &&
          spotifyMatches &&
          releaseTypeMatches &&
          artistMatches &&
          dateMatches
        );
      })
      .sort((left, right) => {
        const primary =
          advancedFilters.sort === "release"
            ? right.releaseDate.localeCompare(left.releaseDate)
            : Date.parse(right.firstSeenAt) - Date.parse(left.firstSeenAt);
        return primary || Date.parse(right.firstSeenAt) - Date.parse(left.firstSeenAt);
      });
  }, [activeFilter, advancedFilters, exactOnly, items, query]);

  const reviewItems = items.filter((item) => item.state === "needs_review");
  const verifiedSoundCloudLinks = Object.values(soundCloudLinks).filter(
    (link) => link.state === "USER_LINKED_VERIFIED",
  );
  const artists: WatchedArtist[] = [
    ...Array.from(new Set(initialItems.map((item) => item.artist))).map((artist) => {
      const releases = items.filter((item) => item.artist === artist);
      const id = `fixture:${artist.toLocaleLowerCase("en-US")}`;
      return {
        addedAt: Math.max(...releases.map((release) => Date.parse(release.firstSeenAt))),
        id,
        manuallyAdded: false,
        name: artistNames[id] ?? artist,
        releases,
      };
    }),
    ...addedArtists.map((artist) => ({ ...artist, name: artistNames[artist.id] ?? artist.name })),
  ].filter((artist) => !removedArtistIds.includes(artist.id));

  const navigate = (view: AppView) => {
    setActiveView(view);
    setNotice(null);
    window.history.replaceState(null, "", `#${view}`);
  };

  const updateItem = (id: string, changes: Partial<FeedFixtureItem>, message: string) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...changes } : item)));
    setNotice(message);
  };

  const addArtist = (name: string): boolean => {
    const normalizedName = name.trim().replace(/\s+/g, " ");
    const alreadyFollowed = artists.some(
      (artist) =>
        artist.name.toLocaleLowerCase("en-US") === normalizedName.toLocaleLowerCase("en-US"),
    );

    if (alreadyFollowed) {
      setNotice(`${normalizedName} is already in the watchlist.`);
      return false;
    }

    setAddedArtists((current) => [
      ...current,
      {
        addedAt: Date.now(),
        id: `manual:${normalizedName.toLocaleLowerCase("en-US")}`,
        manuallyAdded: true,
        name: normalizedName,
        releases: [],
      },
    ]);
    setNotice(`${normalizedName} was added and is awaiting provider mapping.`);
    return true;
  };

  const editArtist = (id: string, name: string): boolean => {
    const normalizedName = name.trim().replace(/\s+/g, " ");
    const duplicate = artists.some(
      (artist) =>
        artist.id !== id &&
        artist.name.toLocaleLowerCase("en-US") === normalizedName.toLocaleLowerCase("en-US"),
    );
    if (!normalizedName || duplicate) return false;
    setArtistNames((current) => ({ ...current, [id]: normalizedName }));
    setNotice(`${normalizedName} was updated.`);
    return true;
  };

  const removeArtist = (id: string, name: string) => {
    setRemovedArtistIds((current) => [...current, id]);
    setArtistProfiles((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setNotice(`${name} was removed from the watchlist.`);
  };

  const saveArtistProfile = (id: string, url: string) => {
    setArtistProfiles((current) => ({ ...current, [id]: url }));
    setNotice("SoundCloud profile link saved without fetching profile data.");
  };

  const removeArtistProfile = (id: string) => {
    setArtistProfiles((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setNotice("SoundCloud profile link removed.");
  };

  const changeSoundCloudLink = (feedItemId: string, record?: SoundCloudLinkRecord) => {
    setSoundCloudLinks((current) => {
      const next = { ...current };
      if (record) next[feedItemId] = record;
      else delete next[feedItemId];
      return next;
    });
    const messages = {
      USER_LINKED_UNVERIFIED: "SoundCloud track URL saved. Verification is still required.",
      USER_LINKED_VERIFIED: "SoundCloud track URL verified and added to the internal collection.",
      USER_LINK_REJECTED: "SoundCloud track URL rejected.",
    } as const;
    setNotice(
      record
        ? (messages[record.state as keyof typeof messages] ?? "SoundCloud link state updated.")
        : "SoundCloud track URL removed.",
    );
  };

  const runMockScan = () => {
    setSyncing(true);
    setNotice(null);
    window.setTimeout(() => {
      setSyncing(false);
      setItems((current) => {
        if (current.some((item) => item.id === scannedItem.id)) {
          setNotice("Mock scan completed. No duplicate discoveries were added.");
          return current;
        }
        setNotice(`Mock scan completed. ${scannedItem.title} was added to the feed.`);
        return [scannedItem, ...current];
      });
    }, 700);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Radio size={19} />
          </span>
          <span>
            TS <strong>RADAR</strong>
          </span>
        </div>

        <PrimaryNavigation
          activeView={activeView}
          discoveryCount={items.length}
          artistCount={artists.length}
          reviewCount={reviewItems.length}
          soundCloudManualLinksEnabled={providerConfiguration.soundcloudManualLinksEnabled}
          soundCloudLinkCount={verifiedSoundCloudLinks.length}
          navigate={navigate}
        />

        <div className="sidebar-section">
          <p>Sources</p>
          {[
            { provider: "mock", label: "Mock provider", connected: true },
            {
              provider: "spotify",
              label: providerConfiguration.spotify.configured
                ? "Spotify configured"
                : "Spotify not configured",
              connected: false,
            },
            {
              provider: "musicbrainz",
              label: providerConfiguration.musicbrainz.configured
                ? "MusicBrainz configured"
                : "MusicBrainz not configured",
              connected: providerConfiguration.musicbrainz.configured,
            },
          ].map(({ provider, label, connected }) => (
            <div className="provider-line" key={provider}>
              <span className={`provider-dot ${provider}`} /> {label}
              {connected ? <Check size={14} /> : <Clock3 className="deferred" size={14} />}
            </div>
          ))}
        </div>

        <div className="sidebar-footer">
          <a
            aria-current={activeView === "settings" ? "page" : undefined}
            className={`nav-link ${activeView === "settings" ? "active" : ""}`}
            href="#settings"
            onClick={() => navigate("settings")}
          >
            <Settings size={17} /> Settings
          </a>
          <div className="profile-row">
            <span className="avatar">TS</span>
            <div>
              <strong>Personal radar</strong>
              <small>Mock mode</small>
            </div>
          </div>
        </div>
      </aside>

      <main className="main" id={activeView}>
        <header className="topbar">
          <div className="mobile-brand">
            <Radio size={18} /> TS RADAR
          </div>
          {activeView === "feed" || activeView === "review" ? (
            <label className="search-field">
              <Search size={17} />
              <input
                aria-label="Search discoveries"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search artist or release"
                type="search"
                value={query}
              />
            </label>
          ) : (
            <div className="topbar-spacer" />
          )}
          <button
            className="icon-button"
            title="Notifications"
            aria-label="Notifications"
            onClick={() => setNotice("No unread notifications in mock mode.")}
          >
            <BellRing size={18} />
          </button>
          <button
            className="icon-button"
            title="Open settings"
            aria-label="Open settings"
            onClick={() => navigate("settings")}
          >
            <MoreHorizontal size={19} />
          </button>
        </header>

        <div className="mobile-navigation">
          <PrimaryNavigation
            activeView={activeView}
            discoveryCount={items.length}
            artistCount={artists.length}
            reviewCount={reviewItems.length}
            soundCloudManualLinksEnabled={providerConfiguration.soundcloudManualLinksEnabled}
            soundCloudLinkCount={verifiedSoundCloudLinks.length}
            navigate={navigate}
          />
        </div>

        {notice && (
          <div className="notice" role="status">
            <Check size={15} /> {notice}
            <button aria-label="Dismiss notification" onClick={() => setNotice(null)}>
              <X size={14} />
            </button>
          </div>
        )}

        {activeView === "feed" && (
          <FeedView
            activeFilter={activeFilter}
            advancedFilters={advancedFilters}
            exactOnly={exactOnly}
            feedMode={feedMode}
            filtersOpen={filtersOpen}
            items={visibleItems}
            soundCloudLinks={soundCloudLinks}
            onFilterChange={setActiveFilter}
            onAdvancedFiltersChange={setAdvancedFilters}
            onItemChange={updateItem}
            onSoundCloudLinkChange={changeSoundCloudLink}
            onToggleExact={() => setExactOnly((value) => !value)}
            onToggleFilters={() => setFiltersOpen((value) => !value)}
            onRunScan={runMockScan}
            ready={hydrated}
            reviewCount={reviewItems.length}
            soundCloudManualLinksEnabled={providerConfiguration.soundcloudManualLinksEnabled}
            syncing={syncing}
          />
        )}

        {activeView === "artists" && (
          <ArtistsView
            artistProfiles={artistProfiles}
            artists={artists}
            onAddArtist={addArtist}
            onEditArtist={editArtist}
            onRemoveArtist={removeArtist}
            onRemoveProfile={removeArtistProfile}
            onSaveProfile={saveArtistProfile}
            soundCloudManualLinksEnabled={providerConfiguration.soundcloudManualLinksEnabled}
          />
        )}
        {activeView === "exports" && (
          <ExportsView
            items={items}
            onNotice={setNotice}
            spotifyConfigured={providerConfiguration.spotify.configured}
          />
        )}
        {activeView === "soundcloud-links" &&
          providerConfiguration.soundcloudManualLinksEnabled && (
            <SoundCloudLinksView items={items} links={verifiedSoundCloudLinks} />
          )}
        {activeView === "review" && (
          <ReviewView items={reviewItems} onItemChange={updateItem} query={query} />
        )}
        {activeView === "status" && <SystemStatusView />}
        {activeView === "settings" && (
          <SettingsView
            dailyScan={dailyScan}
            digest={digest}
            onDailyScanChange={setDailyScan}
            onDigestChange={setDigest}
            onNotice={setNotice}
            onThemeChange={(theme) => {
              setThemePreference(theme);
              setNotice(`Appearance set to ${titleCase(theme)}.`);
            }}
            providerConfiguration={providerConfiguration}
            themePreference={themePreference ?? "system"}
          />
        )}
      </main>
    </div>
  );
}

interface NavigationProps {
  activeView: AppView;
  discoveryCount: number;
  artistCount: number;
  reviewCount: number;
  soundCloudManualLinksEnabled: boolean;
  soundCloudLinkCount: number;
  navigate: (view: AppView) => void;
}

function PrimaryNavigation({
  activeView,
  discoveryCount,
  artistCount,
  reviewCount,
  soundCloudManualLinksEnabled,
  soundCloudLinkCount,
  navigate,
}: NavigationProps) {
  return (
    <nav className="primary-nav">
      <NavItem
        active={activeView === "feed"}
        count={discoveryCount}
        icon={<Inbox size={17} />}
        label="Discovery feed"
        onClick={() => navigate("feed")}
        view="feed"
      />
      <NavItem
        active={activeView === "artists"}
        count={artistCount}
        icon={<Users size={17} />}
        label="Followed artists"
        onClick={() => navigate("artists")}
        view="artists"
      />
      <NavItem
        active={activeView === "exports"}
        icon={<ListMusic size={17} />}
        label="Playlist exports"
        onClick={() => navigate("exports")}
        view="exports"
      />
      {soundCloudManualLinksEnabled && (
        <NavItem
          active={activeView === "soundcloud-links"}
          count={soundCloudLinkCount}
          icon={<Link2 size={17} />}
          label="SoundCloud links"
          onClick={() => navigate("soundcloud-links")}
          view="soundcloud-links"
        />
      )}
      <NavItem
        active={activeView === "review"}
        count={reviewCount}
        icon={<CircleAlert size={17} />}
        label="Review queue"
        onClick={() => navigate("review")}
        view="review"
        warning
      />
      <NavItem
        active={activeView === "status"}
        icon={<Activity size={17} />}
        label="System status"
        onClick={() => navigate("status")}
        view="status"
      />
    </nav>
  );
}

interface NavItemProps {
  active: boolean;
  count?: number;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  view: AppView;
  warning?: boolean;
}

function NavItem({ active, count, icon, label, onClick, view, warning }: NavItemProps) {
  return (
    <a
      aria-current={active ? "page" : undefined}
      className={`nav-link ${active ? "active" : ""}`}
      href={`#${view}`}
      onClick={onClick}
    >
      {icon} {label}
      {count !== undefined && <span className={warning ? "warning-count" : ""}>{count}</span>}
    </a>
  );
}

interface FeedViewProps {
  activeFilter: FeedState | "all";
  advancedFilters: FeedAdvancedFilters;
  exactOnly: boolean;
  feedMode: "database" | "error" | "mock";
  filtersOpen: boolean;
  items: FeedFixtureItem[];
  soundCloudLinks: Record<string, SoundCloudLinkRecord>;
  onFilterChange: (state: FeedState | "all") => void;
  onAdvancedFiltersChange: (filters: FeedAdvancedFilters) => void;
  onItemChange: (id: string, changes: Partial<FeedFixtureItem>, message: string) => void;
  onSoundCloudLinkChange: (feedItemId: string, record?: SoundCloudLinkRecord) => void;
  onRunScan: () => void;
  onToggleExact: () => void;
  onToggleFilters: () => void;
  ready: boolean;
  reviewCount: number;
  soundCloudManualLinksEnabled: boolean;
  syncing: boolean;
}

function FeedView({
  activeFilter,
  advancedFilters,
  exactOnly,
  feedMode,
  filtersOpen,
  items,
  soundCloudLinks,
  onFilterChange,
  onAdvancedFiltersChange,
  onItemChange,
  onSoundCloudLinkChange,
  onRunScan,
  onToggleExact,
  onToggleFilters,
  ready,
  reviewCount,
  soundCloudManualLinksEnabled,
  syncing,
}: FeedViewProps) {
  return (
    <section className="content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            <span className="live-dot" />{" "}
            {feedMode === "database"
              ? "DATABASE FEED"
              : feedMode === "error"
                ? "DATABASE UNAVAILABLE"
                : "MOCK SCAN HEALTHY"}
          </p>
          <h1>Discovery feed</h1>
          <p>Recent signals from your followed artists, ordered by first seen.</p>
        </div>
        {feedMode === "mock" && (
          <button className="scan-button" onClick={onRunScan} disabled={syncing || !ready}>
            <RefreshCw size={16} className={syncing ? "spinning" : ""} />
            {!ready ? "Loading feed" : syncing ? "Scanning" : "Run mock scan"}
          </button>
        )}
      </div>

      <div className="metrics" aria-label="Feed summary">
        <div>
          <span>New this week</span>
          <strong>7</strong>
          <small>+3 since last scan</small>
        </div>
        <div>
          <span>Upcoming</span>
          <strong>2</strong>
          <small>Next 30 days</small>
        </div>
        <div>
          <span>Needs review</span>
          <strong className="attention">{reviewCount}</strong>
          <small>Blocked from export</small>
        </div>
        <div>
          <span>Last scan</span>
          <strong className="time-value">09:10</strong>
          <small>Mock provider · 4 sources</small>
        </div>
      </div>

      <div className="feed-controls">
        <div className="tabs" role="tablist" aria-label="Feed state">
          {filters.map((filter) => (
            <button
              aria-selected={activeFilter === filter.state}
              className={activeFilter === filter.state ? "active" : ""}
              key={filter.state}
              onClick={() => onFilterChange(filter.state)}
              role="tab"
            >
              {filter.label}
              {filter.state === "needs_review" && <span>{reviewCount}</span>}
            </button>
          ))}
        </div>
        <button
          aria-expanded={filtersOpen}
          className={`filter-button ${filtersOpen ? "active" : ""}`}
          onClick={onToggleFilters}
        >
          <SlidersHorizontal size={15} /> Filters
        </button>
      </div>

      {filtersOpen && (
        <div className="filter-panel">
          <label>
            <input checked={exactOnly} onChange={onToggleExact} type="checkbox" />
            Exact matches only
          </label>
          <label>
            Spotify
            <select
              value={advancedFilters.spotify}
              onChange={(event) =>
                onAdvancedFiltersChange({
                  ...advancedFilters,
                  spotify: event.target.value as FeedAdvancedFilters["spotify"],
                })
              }
            >
              <option value="all">All</option>
              <option value="available">Available</option>
              <option value="unavailable">Not on Spotify</option>
            </select>
          </label>
          <label>
            Release type
            <select
              value={advancedFilters.releaseType}
              onChange={(event) =>
                onAdvancedFiltersChange({ ...advancedFilters, releaseType: event.target.value })
              }
            >
              <option value="all">All</option>
              {Array.from(new Set(items.map((item) => item.releaseType)))
                .sort()
                .map((value) => (
                  <option key={value} value={value}>
                    {titleCase(value)}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Artist
            <select
              value={advancedFilters.artist}
              onChange={(event) =>
                onAdvancedFiltersChange({ ...advancedFilters, artist: event.target.value })
              }
            >
              <option value="all">All</option>
              {Array.from(new Set(items.map((item) => item.artist)))
                .sort()
                .map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
            </select>
          </label>
          <label>
            From{" "}
            <input
              aria-label="Release date from"
              onChange={(event) =>
                onAdvancedFiltersChange({ ...advancedFilters, dateFrom: event.target.value })
              }
              type="date"
              value={advancedFilters.dateFrom}
            />
          </label>
          <label>
            To{" "}
            <input
              aria-label="Release date to"
              onChange={(event) =>
                onAdvancedFiltersChange({ ...advancedFilters, dateTo: event.target.value })
              }
              type="date"
              value={advancedFilters.dateTo}
            />
          </label>
          <label>
            Sort
            <select
              value={advancedFilters.sort}
              onChange={(event) =>
                onAdvancedFiltersChange({
                  ...advancedFilters,
                  sort: event.target.value as FeedAdvancedFilters["sort"],
                })
              }
            >
              <option value="release">Release date</option>
              <option value="first-seen">First seen</option>
            </select>
          </label>
          <span>Region: US</span>
        </div>
      )}

      <div className="feed-list" aria-live="polite">
        {feedMode === "error" && (
          <div className="error-state" role="alert">
            The configured database could not be read. Provider credentials remain unavailable to
            the browser.
          </div>
        )}
        {items.length ? (
          items.map((item) => (
            <FeedItem
              item={item}
              key={item.id}
              onItemChange={onItemChange}
              onSoundCloudLinkChange={onSoundCloudLinkChange}
              soundCloudManualLinksEnabled={soundCloudManualLinksEnabled}
              soundCloudLink={soundCloudLinks[item.id]}
            />
          ))
        ) : (
          <div className="empty-state">
            <Search size={22} />
            <strong>No discoveries match this view.</strong>
            <span>Clear the search or choose another state.</span>
          </div>
        )}
      </div>
    </section>
  );
}

function ArtistsView({
  artistProfiles,
  artists,
  onAddArtist,
  onEditArtist,
  onRemoveArtist,
  onRemoveProfile,
  onSaveProfile,
  soundCloudManualLinksEnabled,
}: {
  artistProfiles: Record<string, string>;
  artists: WatchedArtist[];
  onAddArtist: (name: string) => boolean;
  onEditArtist: (id: string, name: string) => boolean;
  onRemoveArtist: (id: string, name: string) => void;
  onRemoveProfile: (id: string) => void;
  onSaveProfile: (id: string, url: string) => void;
  soundCloudManualLinksEnabled: boolean;
}) {
  const [addingArtist, setAddingArtist] = useState(false);
  const [artistName, setArtistName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<ArtistSort>("name-asc");
  const [editingArtistId, setEditingArtistId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [profileArtistId, setProfileArtistId] = useState<string | null>(null);
  const [profileUrl, setProfileUrl] = useState("");
  const [profileError, setProfileError] = useState<string | null>(null);

  const sortedArtists = useMemo(() => {
    return [...artists].sort((left, right) => {
      if (sortOrder === "recent") {
        return right.addedAt - left.addedAt || left.name.localeCompare(right.name, "en-US");
      }

      const comparison = left.name.localeCompare(right.name, "en-US");
      return sortOrder === "name-asc" ? comparison : -comparison;
    });
  }, [artists, sortOrder]);

  const submitArtist = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = artistName.trim();

    if (!name) {
      setFormError("Enter an artist name.");
      return;
    }

    if (!onAddArtist(name)) {
      setFormError("This artist is already followed.");
      return;
    }

    setArtistName("");
    setFormError(null);
    setAddingArtist(false);
  };

  const submitArtistEdit = (event: FormEvent<HTMLFormElement>, artist: WatchedArtist) => {
    event.preventDefault();
    if (!onEditArtist(artist.id, editingName)) {
      setFormError("Enter a unique artist name.");
      return;
    }
    setEditingArtistId(null);
    setEditingName("");
    setFormError(null);
  };

  const submitProfile = (event: FormEvent<HTMLFormElement>, artist: WatchedArtist) => {
    event.preventDefault();
    const result = validateSoundCloudUrl(profileUrl, "profile");
    if (!result.valid || !result.normalizedUrl) {
      setProfileError(result.error ?? "Enter a valid SoundCloud profile URL.");
      return;
    }
    onSaveProfile(artist.id, result.normalizedUrl);
    setProfileArtistId(null);
    setProfileUrl("");
    setProfileError(null);
  };

  return (
    <section className="content standard-view">
      <div className="page-heading">
        <div>
          <p className="eyebrow">PROVIDER-NEUTRAL WATCHLIST</p>
          <h1>Followed artists</h1>
          <p>Canonical artists remain separate from provider account mappings.</p>
        </div>
      </div>

      <div className="artist-toolbar">
        <button
          aria-expanded={addingArtist}
          className="primary-button"
          onClick={() => {
            setAddingArtist((value) => !value);
            setFormError(null);
          }}
        >
          <UserPlus size={15} /> Add artist
        </button>
        <label className="sort-control">
          <span>Sort</span>
          <select
            aria-label="Sort artists"
            onChange={(event) => setSortOrder(event.target.value as ArtistSort)}
            value={sortOrder}
          >
            <option value="name-asc">Name (A-Z)</option>
            <option value="name-desc">Name (Z-A)</option>
            <option value="recent">Recently added</option>
          </select>
        </label>
      </div>

      {addingArtist && (
        <form className="add-artist-form" onSubmit={submitArtist}>
          <label htmlFor="artist-name">Artist name</label>
          <div className="add-artist-controls">
            <input
              autoComplete="off"
              id="artist-name"
              onChange={(event) => {
                setArtistName(event.target.value);
                setFormError(null);
              }}
              placeholder="Enter canonical artist name"
              value={artistName}
            />
            <button className="primary-button" type="submit">
              Add to watchlist
            </button>
            <button
              className="secondary-button"
              onClick={() => {
                setAddingArtist(false);
                setArtistName("");
                setFormError(null);
              }}
              type="button"
            >
              Cancel
            </button>
          </div>
          {formError && <span className="form-error">{formError}</span>}
          <small>Provider IDs can be mapped after the canonical artist is added.</small>
        </form>
      )}

      <div className="data-list" aria-label="Followed artists">
        {sortedArtists.map((artist) => (
          <div className="data-row" key={artist.id}>
            <span className="artist-monogram">{artist.name.slice(0, 2).toUpperCase()}</span>
            <div>
              <strong>{artist.name}</strong>
              <small>
                {artist.manuallyAdded
                  ? "Added manually in mock mode"
                  : `${artist.releases.length} mock discovery signal`}
              </small>
            </div>
            <div className="source-stack">
              {artist.manuallyAdded ? (
                <span className="provider-tag">No provider IDs</span>
              ) : (
                Array.from(
                  new Set(
                    artist.releases.flatMap((release) =>
                      release.sources.map((source) => source.provider),
                    ),
                  ),
                ).map((provider) => (
                  <span className="provider-tag" key={provider}>
                    {provider}
                  </span>
                ))
              )}
              {soundCloudManualLinksEnabled && artistProfiles[artist.id] && (
                <a
                  className="provider-tag"
                  href={artistProfiles[artist.id]}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  SoundCloud profile <ExternalLink size={11} />
                </a>
              )}
            </div>
            <span className={`mapping-status ${artist.manuallyAdded ? "pending" : ""}`}>
              {artist.manuallyAdded ? <Clock3 size={14} /> : <Check size={14} />}
              {artist.manuallyAdded ? "Pending mapping" : "Mapped"}
            </span>
            <div className="row-actions">
              <button
                aria-label={`Edit ${artist.name}`}
                className="icon-button small"
                onClick={() => {
                  setEditingArtistId(artist.id);
                  setEditingName(artist.name);
                  setFormError(null);
                }}
                title="Edit artist"
              >
                <Pencil size={15} />
              </button>
              {soundCloudManualLinksEnabled && (
                <button
                  aria-label={
                    artistProfiles[artist.id]
                      ? `Edit SoundCloud profile for ${artist.name}`
                      : `Add SoundCloud profile for ${artist.name}`
                  }
                  className="icon-button small"
                  onClick={() => {
                    setProfileArtistId(artist.id);
                    setProfileUrl(artistProfiles[artist.id] ?? "");
                    setProfileError(null);
                  }}
                  title="Manage SoundCloud profile"
                >
                  <Link2 size={15} />
                </button>
              )}
              <button
                aria-label={`Remove ${artist.name}`}
                className="icon-button small destructive"
                onClick={() => onRemoveArtist(artist.id, artist.name)}
                title="Remove artist"
              >
                <Trash2 size={15} />
              </button>
            </div>

            {editingArtistId === artist.id && (
              <form
                className="inline-row-form"
                onSubmit={(event) => submitArtistEdit(event, artist)}
              >
                <label htmlFor={`edit-${artist.id}`}>Artist name</label>
                <input
                  id={`edit-${artist.id}`}
                  onChange={(event) => setEditingName(event.target.value)}
                  value={editingName}
                />
                <button className="primary-button" type="submit">
                  Save artist
                </button>
                <button
                  className="secondary-button"
                  onClick={() => setEditingArtistId(null)}
                  type="button"
                >
                  Cancel
                </button>
                {formError && <span className="form-error">{formError}</span>}
              </form>
            )}

            {soundCloudManualLinksEnabled && profileArtistId === artist.id && (
              <form className="inline-row-form" onSubmit={(event) => submitProfile(event, artist)}>
                <label htmlFor={`profile-${artist.id}`}>SoundCloud profile URL</label>
                <input
                  id={`profile-${artist.id}`}
                  onChange={(event) => {
                    setProfileUrl(event.target.value);
                    setProfileError(null);
                  }}
                  placeholder="https://soundcloud.com/artist-name"
                  value={profileUrl}
                />
                <button className="primary-button" type="submit">
                  Save profile
                </button>
                {artistProfiles[artist.id] && (
                  <button
                    className="secondary-button destructive-text"
                    onClick={() => {
                      onRemoveProfile(artist.id);
                      setProfileArtistId(null);
                    }}
                    type="button"
                  >
                    Remove profile
                  </button>
                )}
                <button
                  className="secondary-button"
                  onClick={() => setProfileArtistId(null)}
                  type="button"
                >
                  Cancel
                </button>
                {profileError && <span className="form-error">{profileError}</span>}
              </form>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function ExportsView({
  items,
  onNotice,
  spotifyConfigured,
}: {
  items: FeedFixtureItem[];
  onNotice: (message: string) => void;
  spotifyConfigured: boolean;
}) {
  const readyCount = items.filter((item) => item.exportStatus === "eligible").length;
  const exportedCount = items.filter((item) => item.exportStatus === "exported").length;
  const [playlistName, setPlaylistName] = useState("Release Inbox");
  const [autoAdd, setAutoAdd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{
    alreadyPresent: string[];
    rejected: unknown[];
    toAdd: string[];
  } | null>(null);
  const [privatePlaylists, setPrivatePlaylists] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState("");

  const playlistRequest = async (path: string, method: "GET" | "POST", body?: unknown) => {
    setBusy(true);
    try {
      const response = await fetch(path, {
        ...(body
          ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
          : {}),
        method,
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error("Spotify playlist request failed");
      return payload;
    } finally {
      setBusy(false);
    }
  };

  const createPlaylist = async () => {
    try {
      await playlistRequest("/api/spotify/playlists", "POST", {
        mode: "create",
        name: playlistName,
      });
      onNotice(`Private Spotify playlist ${playlistName} is configured.`);
    } catch {
      onNotice("Unable to create the private Spotify playlist.");
    }
  };

  const previewSync = async () => {
    try {
      const payload = z
        .object({
          alreadyPresent: z.array(z.string()),
          rejected: z.array(z.unknown()),
          toAdd: z.array(z.string()),
        })
        .parse(await playlistRequest("/api/spotify/playlist-sync", "GET"));
      setPreview(payload);
    } catch {
      onNotice("Unable to preview Spotify playlist synchronization.");
    }
  };

  const syncPlaylist = async () => {
    try {
      const payload = z
        .object({ added: z.array(z.string()) })
        .passthrough()
        .parse(await playlistRequest("/api/spotify/playlist-sync", "POST"));
      onNotice(`Spotify playlist synchronized. ${payload.added.length} tracks added.`);
      await previewSync();
    } catch {
      onNotice("Unable to synchronize the Spotify playlist.");
    }
  };

  const updateAutoAdd = async (enabled: boolean) => {
    try {
      await playlistRequest("/api/spotify/playlists", "POST", { enabled, mode: "auto_add" });
      setAutoAdd(enabled);
      onNotice(`Auto-add exact matches ${enabled ? "enabled" : "disabled"}.`);
    } catch {
      onNotice("Unable to update auto-add.");
    }
  };

  const loadPlaylists = async () => {
    try {
      const payload = z
        .object({
          playlists: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
          target: z.object({ autoAddExactMatches: z.boolean() }).nullable().optional(),
        })
        .parse(await playlistRequest("/api/spotify/playlists", "GET"));
      setPrivatePlaylists(payload.playlists);
      setAutoAdd(payload.target?.autoAddExactMatches ?? false);
      setSelectedPlaylistId(payload.playlists[0]?.id ?? "");
    } catch {
      onNotice("Unable to load owned private Spotify playlists.");
    }
  };

  const selectPlaylist = async () => {
    if (!selectedPlaylistId) return;
    try {
      await playlistRequest("/api/spotify/playlists", "POST", {
        mode: "select",
        playlistId: selectedPlaylistId,
      });
      onNotice("Existing private Spotify playlist selected.");
    } catch {
      onNotice("Unable to select that Spotify playlist.");
    }
  };
  return (
    <section className="content standard-view">
      <div className="page-heading">
        <div>
          <p className="eyebrow">SPOTIFY-ONLY PLAYLIST TARGET</p>
          <h1>Playlist exports</h1>
          <p>Spotify export and the internal saved-release collection remain separate.</p>
        </div>
      </div>
      <div className="export-grid">
        <article className="provider-card">
          <div className="provider-card-heading">
            <span className="provider-dot spotify" />
            <div>
              <h2>Spotify private release inbox</h2>
              <p>
                {spotifyConfigured
                  ? "Private playlist target"
                  : "Spotify credentials are not configured"}
              </p>
            </div>
          </div>
          <dl>
            <div>
              <dt>Ready</dt>
              <dd>{readyCount}</dd>
            </div>
            <div>
              <dt>Exported</dt>
              <dd>{exportedCount}</dd>
            </div>
            <div>
              <dt>Blocked</dt>
              <dd>{items.length - readyCount - exportedCount}</dd>
            </div>
          </dl>
          <label className="playlist-name-control">
            <span>Playlist name</span>
            <input
              disabled={!spotifyConfigured || busy}
              maxLength={100}
              onChange={(event) => setPlaylistName(event.target.value)}
              value={playlistName}
            />
          </label>
          <label className="playlist-toggle">
            <input
              checked={autoAdd}
              disabled={!spotifyConfigured || busy}
              onChange={(event) => void updateAutoAdd(event.target.checked)}
              type="checkbox"
            />
            Auto-add exact matches
          </label>
          <div className="row-actions">
            <button
              className="secondary-button"
              disabled={!spotifyConfigured || busy || !playlistName.trim()}
              onClick={() => void createPlaylist()}
              type="button"
            >
              Create private playlist
            </button>
            <button
              className="secondary-button"
              disabled={!spotifyConfigured || busy}
              onClick={() => void loadPlaylists()}
              type="button"
            >
              Load private playlists
            </button>
            <button
              className="secondary-button"
              disabled={!spotifyConfigured || busy}
              onClick={() => void previewSync()}
              type="button"
            >
              Preview sync
            </button>
            <button
              className="secondary-button"
              disabled={!spotifyConfigured || busy}
              onClick={() => void syncPlaylist()}
              type="button"
            >
              <RefreshCw size={15} /> Sync playlist
            </button>
          </div>
          {privatePlaylists.length > 0 && (
            <div className="playlist-selector">
              <select
                aria-label="Existing private Spotify playlist"
                onChange={(event) => setSelectedPlaylistId(event.target.value)}
                value={selectedPlaylistId}
              >
                {privatePlaylists.map((playlist) => (
                  <option key={playlist.id} value={playlist.id}>
                    {playlist.name}
                  </option>
                ))}
              </select>
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => void selectPlaylist()}
                type="button"
              >
                Use selected playlist
              </button>
            </div>
          )}
          {preview && (
            <div className="sync-preview" role="status">
              <span>{preview.toAdd.length} to add</span>
              <span>{preview.alreadyPresent.length} already present</span>
              <span>{preview.rejected.length} blocked</span>
            </div>
          )}
        </article>
        <article className="provider-card">
          <div className="provider-card-heading">
            <Bookmark size={17} />
            <div>
              <h2>Saved releases</h2>
              <p>Internal provider-neutral collection</p>
            </div>
          </div>
          <dl>
            <div>
              <dt>Saved</dt>
              <dd>{items.filter((item) => item.state === "saved").length}</dd>
            </div>
            <div>
              <dt>Listened</dt>
              <dd>{items.filter((item) => item.state === "listened").length}</dd>
            </div>
            <div>
              <dt>Dismissed</dt>
              <dd>{items.filter((item) => item.state === "dismissed").length}</dd>
            </div>
          </dl>
        </article>
      </div>
      <p className="policy-note">
        No SoundCloud-hosted playlist, combined player, or mixed-provider queue is created.
      </p>
    </section>
  );
}

function SoundCloudLinksView({
  items,
  links,
}: {
  items: FeedFixtureItem[];
  links: SoundCloudLinkRecord[];
}) {
  return (
    <section className="content standard-view">
      <div className="page-heading">
        <div>
          <p className="eyebrow">INTERNAL OUTBOUND LINK COLLECTION</p>
          <h1>SoundCloud links</h1>
          <p>Only manually verified HTTPS SoundCloud URLs appear here.</p>
        </div>
      </div>
      {links.length ? (
        <div className="data-list" aria-label="Verified SoundCloud links">
          {links.map((link) => {
            const item = items.find((candidate) => candidate.id === link.feedItemId);
            return (
              <div className="soundcloud-link-row" key={link.feedItemId}>
                <Link2 size={18} />
                <div>
                  <strong>{item?.title ?? "Unknown track"}</strong>
                  <small>{item?.artist ?? "Unknown artist"}</small>
                </div>
                <span>Verified by {link.verifier}</span>
                <a href={link.url} rel="noopener noreferrer" target="_blank">
                  Open on SoundCloud <ExternalLink size={13} />
                </a>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty-state">
          <Link2 size={22} />
          <strong>No verified SoundCloud links.</strong>
          <span>Verify a user-entered track URL from the discovery feed.</span>
        </div>
      )}
    </section>
  );
}

function ReviewView({
  items,
  onItemChange,
  query,
}: {
  items: FeedFixtureItem[];
  onItemChange: (id: string, changes: Partial<FeedFixtureItem>, message: string) => void;
  query: string;
}) {
  const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
  const visibleItems = items.filter((item) =>
    `${item.artist} ${item.title}`.toLocaleLowerCase("en-US").includes(normalizedQuery),
  );

  return (
    <section className="content standard-view">
      <div className="page-heading">
        <div>
          <p className="eyebrow">AUTOMATION BLOCKED</p>
          <h1>Review queue</h1>
          <p>Ambiguous matches require an explicit decision before playlist export.</p>
        </div>
      </div>
      <div className="review-list">
        {visibleItems.length ? (
          visibleItems.map((item) => (
            <article className="review-card" key={item.id}>
              <div>
                <span className="state state-needs_review">Needs review</span>
                <h2>{item.title}</h2>
                <p>{item.artist}</p>
                <small>
                  {Math.round(item.confidence * 100)}% confidence · {item.matchReason}
                </small>
              </div>
              <div className="review-actions">
                <button
                  className="secondary-button"
                  onClick={() =>
                    onItemChange(
                      item.id,
                      { state: "dismissed", exportStatus: "blocked" },
                      `${item.title} was kept as a separate recording.`,
                    )
                  }
                >
                  Keep separate
                </button>
                <button
                  className="primary-button"
                  onClick={() =>
                    onItemChange(
                      item.id,
                      {
                        state: "new",
                        confidence: 1,
                        matchReason: "Manually confirmed match",
                        exportStatus: item.spotify === "playable" ? "eligible" : "blocked",
                      },
                      item.spotify === "playable"
                        ? `${item.title} was manually confirmed and is eligible for Spotify export.`
                        : `${item.title} was manually confirmed; Spotify export remains unavailable.`,
                    )
                  }
                >
                  <Check size={15} /> Confirm match
                </button>
              </div>
            </article>
          ))
        ) : (
          <div className="empty-state">
            <Check size={22} />
            <strong>No items need review.</strong>
            <span>Ambiguous future matches will appear here.</span>
          </div>
        )}
      </div>
    </section>
  );
}

interface SettingsViewProps {
  dailyScan: boolean;
  digest: boolean;
  onDailyScanChange: (value: boolean) => void;
  onDigestChange: (value: boolean) => void;
  onNotice: (message: string) => void;
  onThemeChange: (value: ThemePreference) => void;
  providerConfiguration: ProviderUiConfiguration;
  themePreference: ThemePreference;
}

const systemStatusSchema = z.object({
  backup: z.object({ lastCompletedAt: z.string().nullable() }),
  database: z.object({
    configured: z.boolean(),
    connected: z.boolean().optional(),
    error: z.string().optional(),
    migrationCount: z.number().optional(),
    migrationCurrent: z.boolean().optional(),
    state: z.string().optional(),
  }),
  generatedAt: z.string(),
  musicbrainz: z.object({
    configured: z.boolean(),
    enabled: z.boolean(),
    lastError: z.string().nullable().optional(),
    lastRateLimitWaitMs: z.number().nullable().optional(),
    lastSuccessfulScanAt: z.string().nullable().optional(),
    mappingReviewCount: z.number().optional(),
    userAgentConfigured: z.boolean(),
  }),
  reddit: z.object({
    approvalRecorded: z.boolean(),
    configured: z.boolean(),
    credentialsConfigured: z.boolean(),
    enabled: z.boolean(),
    lastDeletionReconciliationAt: z.string().nullable().optional(),
    lastError: z.string().nullable().optional(),
    lastScanAt: z.string().nullable().optional(),
    reviewCount: z.number().optional(),
  }),
  scanner: z
    .object({
      activeScanId: z.string().nullable(),
      failedProviderCount: z.number(),
      lastCompletedAt: z.string().nullable(),
      lockCount: z.number(),
      running: z.boolean(),
      staleLockCount: z.number(),
    })
    .optional(),
  scheduler: z.object({
    expectedNextScanAt: z.string().nullable(),
    managedByApplication: z.boolean(),
    recommendedCommand: z.string(),
    schedule: z.string().nullable(),
  }),
  spotify: z.object({
    configured: z.boolean(),
    connected: z.boolean().optional(),
    enabled: z.boolean(),
    followedArtistsImported: z.boolean().optional(),
    grantedScopes: z.array(z.string()).optional(),
    lastError: z.string().nullable().optional(),
    lastPlaylistSyncAt: z.string().nullable().optional(),
    lastSuccessfulRequestAt: z.string().nullable().optional(),
    lastSuccessfulScanAt: z.string().nullable().optional(),
    playlistConfigured: z.boolean().optional(),
    redirectUriValid: z.boolean(),
    requiredScopes: z.array(z.string()),
  }),
});

type SystemStatus = z.infer<typeof systemStatusSchema>;

function SystemStatusView() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");

  const loadStatus = async () => {
    setState("loading");
    try {
      const response = await fetch("/api/system/status", { cache: "no-store" });
      const payload = systemStatusSchema.parse(await response.json());
      setStatus(payload);
      setState(response.ok ? "loaded" : "error");
    } catch {
      setState("error");
    }
  };

  useEffect(() => {
    void loadStatus();
  }, []);

  return (
    <section className="content standard-view">
      <div className="page-heading heading-with-actions">
        <div>
          <p className="eyebrow">LOCAL OPERATION</p>
          <h1>System status</h1>
          <p>Database, provider, scanner, backup, and external scheduling readiness.</p>
        </div>
        <button
          aria-label="Refresh system status"
          className="secondary-button"
          disabled={state === "loading"}
          onClick={() => void loadStatus()}
          type="button"
        >
          <RefreshCw size={15} /> {state === "loading" ? "Checking" : "Refresh"}
        </button>
      </div>
      {state === "error" && !status && (
        <div className="error-state" role="alert">
          <CircleAlert size={20} />
          <strong>Status could not be loaded.</strong>
          <span>Run pnpm doctor for command-line diagnostics.</span>
        </div>
      )}
      {status && (
        <div className="settings-list status-list" aria-live="polite">
          <StatusSection
            details={[
              ["Connection", status.database.connected ? "Connected" : "Unavailable"],
              [
                "Migrations",
                status.database.migrationCurrent
                  ? `${status.database.migrationCount ?? 0} applied, current`
                  : "Action required",
              ],
              ["Last backup", formatStatusDate(status.backup.lastCompletedAt)],
            ]}
            error={status.database.error}
            name="Database"
            ready={Boolean(status.database.connected && status.database.migrationCurrent)}
          />
          <StatusSection
            details={[
              ["Enabled", yesNo(status.spotify.enabled)],
              ["Configured", yesNo(status.spotify.configured)],
              ["Connected", yesNo(status.spotify.connected)],
              ["Scopes granted", status.spotify.grantedScopes?.join(", ") || "Not available"],
              ["Last request", formatStatusDate(status.spotify.lastSuccessfulRequestAt)],
              ["Last scan", formatStatusDate(status.spotify.lastSuccessfulScanAt)],
              ["Playlist configured", yesNo(status.spotify.playlistConfigured)],
              ["Last playlist sync", formatStatusDate(status.spotify.lastPlaylistSyncAt)],
            ]}
            error={status.spotify.lastError}
            name="Spotify"
            ready={Boolean(
              status.spotify.enabled && status.spotify.configured && status.spotify.connected,
            )}
          />
          <StatusSection
            details={[
              ["Enabled", yesNo(status.musicbrainz.enabled)],
              ["User-Agent configured", yesNo(status.musicbrainz.userAgentConfigured)],
              ["Last scan", formatStatusDate(status.musicbrainz.lastSuccessfulScanAt)],
              ["Last rate-limit wait", `${status.musicbrainz.lastRateLimitWaitMs ?? 0} ms`],
              ["Mapping reviews", String(status.musicbrainz.mappingReviewCount ?? 0)],
            ]}
            error={status.musicbrainz.lastError}
            name="MusicBrainz"
            ready={status.musicbrainz.enabled && status.musicbrainz.configured}
          />
          <StatusSection
            details={[
              ["Enabled", yesNo(status.reddit.enabled)],
              ["Approval recorded", yesNo(status.reddit.approvalRecorded)],
              ["Credentials configured", yesNo(status.reddit.credentialsConfigured)],
              ["Last scan", formatStatusDate(status.reddit.lastScanAt)],
              [
                "Last deletion reconciliation",
                formatStatusDate(status.reddit.lastDeletionReconciliationAt),
              ],
              ["Reviews", String(status.reddit.reviewCount ?? 0)],
            ]}
            error={status.reddit.lastError}
            name="Reddit"
            ready={!status.reddit.enabled || status.reddit.configured}
            statusLabel={status.reddit.enabled ? undefined : "Optional provider disabled"}
          />
          <StatusSection
            details={[
              ["State", status.scanner?.running ? "Running" : "Idle"],
              ["Active scan", status.scanner?.activeScanId ?? "None"],
              ["Last completed", formatStatusDate(status.scanner?.lastCompletedAt)],
              ["Failed providers", String(status.scanner?.failedProviderCount ?? 0)],
              ["Stale locks", String(status.scanner?.staleLockCount ?? 0)],
            ]}
            name="Scanner"
            ready={Boolean(status.scanner && status.scanner.staleLockCount === 0)}
          />
          <StatusSection
            details={[
              ["Command", status.scheduler.recommendedCommand],
              ["Schedule", status.scheduler.schedule ?? "Not entered"],
              ["Expected next scan", formatStatusDate(status.scheduler.expectedNextScanAt)],
              ["Managed by application", "No"],
            ]}
            error="An external scheduler such as Windows Task Scheduler or cron is required."
            name="Daily scheduling"
            ready={false}
            statusLabel="External scheduler required"
          />
        </div>
      )}
    </section>
  );
}

function StatusSection({
  details,
  error,
  name,
  ready,
  statusLabel,
}: {
  details: Array<[string, string]>;
  error?: string | null | undefined;
  name: string;
  ready: boolean;
  statusLabel?: string | undefined;
}) {
  return (
    <div className="setting-row status-section">
      <div className="status-section-heading">
        <strong>{name}</strong>
        <span className={`mock-badge ${ready ? "status-ready" : "status-action"}`}>
          {statusLabel ?? (ready ? "Ready" : "Action required")}
        </span>
      </div>
      <dl className="status-detail-grid">
        {details.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {error && <small className="status-message">{error}</small>}
    </div>
  );
}

function yesNo(value: boolean | undefined): string {
  return value ? "Yes" : "No";
}

function formatStatusDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "Not recorded";
}

function SettingsView({
  dailyScan,
  digest,
  onDailyScanChange,
  onDigestChange,
  onNotice,
  onThemeChange,
  providerConfiguration,
  themePreference,
}: SettingsViewProps) {
  const [confirmDeletion, setConfirmDeletion] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const deleteApplicationData = async () => {
    setDeleting(true);
    try {
      const response = await fetch("/api/account/data", {
        body: JSON.stringify({ confirmation: "DELETE ALL DATA" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error("Deletion failed");
      onNotice("All local application data was deleted.");
      setConfirmDeletion(false);
    } catch {
      onNotice("Unable to delete local application data.");
    } finally {
      setDeleting(false);
    }
  };
  return (
    <section className="content standard-view">
      <div className="page-heading">
        <div>
          <p className="eyebrow">PROVIDER AND LOCAL CONFIGURATION</p>
          <h1>Settings</h1>
          <p>Connect providers, review operational state, and manage local data.</p>
        </div>
      </div>
      <div className="settings-list">
        <ProviderSetting
          configured={providerConfiguration.spotify.configured}
          enabled={providerConfiguration.spotify.enabled}
          name="Spotify"
        />
        <SpotifySetupChecklist
          configured={providerConfiguration.spotify.configured}
          enabled={providerConfiguration.spotify.enabled}
        />
        <ProviderSetting
          configured={providerConfiguration.musicbrainz.configured}
          enabled={providerConfiguration.musicbrainz.enabled}
          name="MusicBrainz"
        />
        <RedditSourceSettings databaseConfigured={providerConfiguration.databaseConfigured} />
        <div className="setting-row">
          <div>
            <strong>Appearance</strong>
            <small>Use the system color scheme or choose a fixed theme.</small>
          </div>
          <div className="theme-select-wrapper">
            <select
              aria-label="Appearance"
              className="theme-select"
              onChange={(event) => onThemeChange(event.target.value as ThemePreference)}
              value={themePreference}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
            <ChevronDown aria-hidden="true" size={15} />
          </div>
        </div>
        <label className="setting-row">
          <div>
            <strong>Daily scanner</strong>
            <small>Enable the schedule boundary for a future cron runner.</small>
          </div>
          <input
            checked={dailyScan}
            onChange={(event) => onDailyScanChange(event.target.checked)}
            type="checkbox"
          />
        </label>
        <label className="setting-row">
          <div>
            <strong>Discovery digest</strong>
            <small>Prepare a summary after a completed daily scan.</small>
          </div>
          <input
            checked={digest}
            onChange={(event) => onDigestChange(event.target.checked)}
            type="checkbox"
          />
        </label>
        <div className="setting-row">
          <div>
            <strong>OAuth storage</strong>
            <small>Refresh tokens will be encrypted before database storage.</small>
          </div>
          <span className="mock-badge">Not connected</span>
        </div>
        <div className="setting-row">
          <div>
            <strong>Manual SoundCloud links</strong>
            <small>No API, embedded player, page fetch, or hosted playlist is used.</small>
          </div>
          <span className="mock-badge">
            {providerConfiguration.soundcloudManualLinksEnabled ? "Enabled" : "Disabled"}
          </span>
        </div>
        <div className="setting-row">
          <div>
            <strong>Privacy and terms</strong>
            <small>Review local data handling and provider policy boundaries.</small>
          </div>
          <div className="row-actions">
            <a className="secondary-button" href="/privacy">
              Privacy
            </a>
            <a className="secondary-button" href="/terms">
              Terms
            </a>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>Delete all application data</strong>
            <small>
              Deletes tokens, watchlist, feed, evidence, scan history, and export records.
            </small>
          </div>
          <button
            className="secondary-button destructive-text"
            disabled={deleting}
            onClick={() => setConfirmDeletion(true)}
            type="button"
          >
            Delete data
          </button>
          {confirmDeletion && (
            <div
              className="inline-confirmation"
              role="alertdialog"
              aria-label="Confirm all data deletion"
            >
              <p>
                This cannot be undone. Spotify playlist items already hosted by Spotify are not
                removed.
              </p>
              <button
                className="secondary-button destructive-text"
                disabled={deleting}
                onClick={() => void deleteApplicationData()}
                type="button"
              >
                Confirm delete all data
              </button>
              <button
                className="secondary-button"
                onClick={() => setConfirmDeletion(false)}
                type="button"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
        <ScanHistory databaseConfigured={providerConfiguration.databaseConfigured} />
      </div>
    </section>
  );
}

const scanHistorySchema = z.object({
  runs: z.array(
    z.object({
      completedAt: z.string().nullable(),
      discoveredCount: z.number(),
      dryRun: z.boolean(),
      insertedCount: z.number(),
      provider: z.string().nullable(),
      reviewCount: z.number(),
      skippedCount: z.number(),
      startedAt: z.string(),
      status: z.string(),
    }),
  ),
});

function ScanHistory({ databaseConfigured }: { databaseConfigured: boolean }) {
  const [runs, setRuns] = useState<z.infer<typeof scanHistorySchema>["runs"]>([]);
  const [state, setState] = useState<"idle" | "loading" | "loaded" | "error">("idle");

  const loadHistory = async () => {
    setState("loading");
    try {
      const response = await fetch("/api/scans");
      if (!response.ok) throw new Error("History request failed");
      const payload = scanHistorySchema.parse(await response.json());
      setRuns(payload.runs);
      setState("loaded");
    } catch {
      setState("error");
    }
  };

  return (
    <div className="setting-row scan-history-setting">
      <div>
        <strong>Scan history</strong>
        <small>Provider results, counts, dry-run state, and sanitized errors.</small>
      </div>
      <button
        className="secondary-button"
        disabled={!databaseConfigured || state === "loading"}
        onClick={() => void loadHistory()}
        type="button"
      >
        {state === "loading"
          ? "Loading history"
          : databaseConfigured
            ? "Load history"
            : "Database not configured"}
      </button>
      {state === "error" && <span className="form-error">Unable to load scan history.</span>}
      {state === "loaded" && runs.length === 0 && (
        <span className="empty-inline">No scan runs recorded.</span>
      )}
      {runs.length > 0 && (
        <div className="scan-history-list">
          {runs.map((run) => (
            <div key={`${run.startedAt}-${run.provider ?? "all"}`}>
              <strong>
                {run.provider ?? "all providers"} {run.status}
              </strong>
              <span>
                {new Date(run.startedAt).toLocaleString()} to{" "}
                {run.completedAt ? new Date(run.completedAt).toLocaleString() : "running"}
              </span>
              <span>
                {run.discoveredCount} candidates, {run.insertedCount} created, {run.skippedCount}{" "}
                duplicates, {run.reviewCount} review
                {run.dryRun ? ", dry run" : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderSetting({
  configured,
  enabled,
  name,
}: {
  configured: boolean;
  enabled: boolean;
  name: "Spotify" | "MusicBrainz";
}) {
  const [spotifyStatus, setSpotifyStatus] = useState<z.infer<typeof spotifyStatusSchema> | null>(
    null,
  );
  const [loading, setLoading] = useState(name === "Spotify" && configured);
  const [error, setError] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [importPreview, setImportPreview] = useState<z.infer<typeof importPreviewSchema> | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (name !== "Spotify" || !configured) return;
    let cancelled = false;
    fetch("/api/spotify/status")
      .then(async (response) => spotifyStatusSchema.parse(await response.json()))
      .then((status) => {
        if (!cancelled) setSpotifyStatus(status);
      })
      .catch(() => {
        if (!cancelled) setError("Unable to load Spotify connection status.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [configured, name]);

  const status = !enabled ? "Disabled" : configured ? "Configured" : "Missing credentials";
  const previewImport = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/spotify/import/preview", { method: "POST" });
      const body = importPreviewSchema.parse(await response.json());
      if (!response.ok) throw new Error("Unable to preview followed artists.");
      setImportPreview(body);
    } catch {
      setError("Unable to preview followed artists.");
    } finally {
      setSubmitting(false);
    }
  };
  const confirmImport = async () => {
    if (!importPreview) return;
    setSubmitting(true);
    setError(null);
    try {
      const decisions = importPreview.candidates.map((candidate) => ({
        candidateId: candidate.id,
        decision: candidate.proposedAction === "review" ? "skip" : candidate.proposedAction,
        ...(candidate.existingArtistId ? { existingArtistId: candidate.existingArtistId } : {}),
        selected: candidate.selected,
      }));
      const response = await fetch("/api/spotify/import/confirm", {
        body: JSON.stringify({ decisions, importRunId: importPreview.importRunId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const summary = importSummarySchema.parse(await response.json());
      if (!response.ok) throw new Error("Unable to confirm import.");
      setImportPreview(null);
      setError(
        `Import complete: ${summary.created} created, ${summary.merged} merged, ${summary.skipped} skipped.`,
      );
    } catch {
      setError("Unable to confirm followed-artist import.");
    } finally {
      setSubmitting(false);
    }
  };
  const disconnect = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/spotify/disconnect", { method: "POST" });
      if (!response.ok) throw new Error("Disconnect failed");
      setSpotifyStatus({ state: "disconnected" });
      setConfirmDisconnect(false);
    } catch {
      setError("Spotify disconnect failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="setting-row">
      <div>
        <strong>{name}</strong>
        <small>
          {name === "Spotify"
            ? "Server-side OAuth, followed-artist import, catalog discovery, and private playlist export."
            : "Public metadata discovery using your contact email; no account connection is required."}
        </small>
      </div>
      {name === "Spotify" && configured && loading ? (
        <span className="mock-badge" role="status">
          Loading
        </span>
      ) : name === "Spotify" && configured && spotifyStatus?.state === "connected" ? (
        <div className="provider-setting-actions">
          <span className="mock-badge">
            Connected: {spotifyStatus.displayName ?? "Spotify account"}
          </span>
          <small>{spotifyStatus.scopes?.join(", ")}</small>
          <button
            className="secondary-button"
            disabled={submitting}
            onClick={() => void previewImport()}
            type="button"
          >
            Import followed artists
          </button>
          <button
            className="secondary-button destructive-text"
            disabled={submitting}
            onClick={() => setConfirmDisconnect(true)}
            type="button"
          >
            Disconnect Spotify
          </button>
        </div>
      ) : name === "Spotify" && configured && spotifyStatus?.state === "missing_configuration" ? (
        <button className="secondary-button" disabled type="button">
          Database not configured
        </button>
      ) : name === "Spotify" && configured ? (
        <a className="primary-button" href="/api/auth/spotify/start">
          {spotifyStatus?.state === "reconnect_required" ? "Reconnect Spotify" : "Connect Spotify"}
        </a>
      ) : name === "MusicBrainz" ? (
        <span className="mock-badge" role="status">
          {enabled && configured ? "Ready" : status}
        </span>
      ) : (
        <button className="secondary-button" disabled type="button">
          {status}
        </button>
      )}
      {confirmDisconnect && (
        <div
          className="inline-confirmation"
          role="alertdialog"
          aria-label="Confirm Spotify disconnect"
        >
          <p>
            Tokens and personal Spotify account data will be deleted. Canonical watchlist records
            remain.
          </p>
          <button
            className="secondary-button destructive-text"
            disabled={submitting}
            onClick={() => void disconnect()}
            type="button"
          >
            Confirm disconnect
          </button>
          <button
            className="secondary-button"
            onClick={() => setConfirmDisconnect(false)}
            type="button"
          >
            Cancel
          </button>
        </div>
      )}
      {importPreview && (
        <div className="import-preview">
          <strong>Import preview: {importPreview.retrieved} followed artists</strong>
          <div className="row-actions">
            <button
              className="secondary-button"
              onClick={() =>
                setImportPreview({
                  ...importPreview,
                  candidates: importPreview.candidates.map((candidate) => ({
                    ...candidate,
                    selected: true,
                  })),
                })
              }
              type="button"
            >
              Select all
            </button>
            <button
              className="secondary-button"
              onClick={() =>
                setImportPreview({
                  ...importPreview,
                  candidates: importPreview.candidates.map((candidate) => ({
                    ...candidate,
                    selected: false,
                  })),
                })
              }
              type="button"
            >
              Deselect all
            </button>
          </div>
          {importPreview.candidates.map((candidate) => (
            <label className="import-candidate" key={candidate.id}>
              <input
                checked={candidate.selected}
                onChange={(event) =>
                  setImportPreview({
                    ...importPreview,
                    candidates: importPreview.candidates.map((item) =>
                      item.id === candidate.id ? { ...item, selected: event.target.checked } : item,
                    ),
                  })
                }
                type="checkbox"
              />
              <span>
                <strong>{candidate.providerName}</strong>
                <small>{candidate.proposedAction.replace("_", " ")}</small>
              </span>
              <a href={candidate.providerUrl} rel="noopener noreferrer" target="_blank">
                Spotify <ExternalLink size={12} />
              </a>
            </label>
          ))}
          <button
            className="primary-button"
            disabled={submitting}
            onClick={() => void confirmImport()}
            type="button"
          >
            Confirm import
          </button>
        </div>
      )}
      {error && (
        <span className={error.startsWith("Import complete") ? "form-success" : "form-error"}>
          {error}
        </span>
      )}
    </div>
  );
}

function SpotifySetupChecklist({ configured, enabled }: { configured: boolean; enabled: boolean }) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/system/status", { cache: "no-store" })
      .then(async (response) => systemStatusSchema.parse(await response.json()))
      .then((payload) => {
        if (!cancelled) setStatus(payload);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const granted = new Set(status?.spotify.grantedScopes ?? []);
  const scopesGranted =
    status?.spotify.requiredScopes.every((scope) => granted.has(scope)) ?? false;
  const entries: Array<[string, boolean]> = [
    ["Development application created", configured],
    ["Redirect URI configured", status?.spotify.redirectUriValid ?? false],
    ["Client ID configured", configured],
    ["Client secret configured", configured],
    ["Encryption key configured", configured],
    ["Spotify feature enabled", enabled],
    ["Account connected", status?.spotify.connected ?? false],
    ["Required scopes granted", scopesGranted],
    ["Followed artists imported", status?.spotify.followedArtistsImported ?? false],
    ["Release Inbox playlist selected or created", status?.spotify.playlistConfigured ?? false],
  ];
  return (
    <div className="setting-row setup-checklist-row">
      <div>
        <strong>Spotify setup checklist</strong>
        <small>Configuration values remain server-side and are never displayed here.</small>
      </div>
      <ul className="setup-checklist">
        {entries.map(([label, complete]) => (
          <li key={label}>
            {complete ? (
              <Check aria-hidden="true" size={14} />
            ) : (
              <Clock3 aria-hidden="true" size={14} />
            )}
            <span>{label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const redditSourcesSchema = z.object({
  approvalRecorded: z.boolean(),
  enabled: z.boolean(),
  sources: z.array(
    z.object({
      enabled: z.boolean(),
      id: z.string(),
      lastError: z.string().nullable(),
      lastSuccessfulScanAt: z.string().nullable(),
      subreddit: z.string(),
    }),
  ),
});

function RedditSourceSettings({ databaseConfigured }: { databaseConfigured: boolean }) {
  const [payload, setPayload] = useState<z.infer<typeof redditSourcesSchema> | null>(null);
  const [subreddit, setSubreddit] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadSources = async () => {
    try {
      const response = await fetch("/api/reddit/sources", { cache: "no-store" });
      if (!response.ok) throw new Error("Source request failed");
      setPayload(redditSourcesSchema.parse(await response.json()));
    } catch {
      if (databaseConfigured) setError("Unable to load Reddit source configuration.");
    }
  };
  useEffect(() => {
    void loadSources();
  }, [databaseConfigured]);

  const addSource = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/reddit/sources", {
        body: JSON.stringify({ subreddit }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error("Source creation failed");
      setSubreddit("");
      await loadSources();
    } catch {
      setError("Enter a unique subreddit name using letters, numbers, or underscores.");
    } finally {
      setSubmitting(false);
    }
  };

  const updateSource = async (id: string, enabled: boolean) => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/reddit/sources/${id}`, {
        body: JSON.stringify({ enabled }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      if (!response.ok) throw new Error("Source update failed");
      await loadSources();
    } catch {
      setError("Unable to update the Reddit source.");
    } finally {
      setSubmitting(false);
    }
  };

  const removeSource = async (id: string) => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/reddit/sources/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Source removal failed");
      await loadSources();
    } catch {
      setError("Unable to remove the Reddit source.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="setting-row reddit-source-setting">
      <div>
        <strong>Reddit sources</strong>
        <small>
          Configure sources locally. Network scanning remains blocked until Reddit is enabled and
          explicit approval is recorded.
        </small>
      </div>
      <span className="mock-badge">
        {payload?.enabled && payload.approvalRecorded
          ? "Approved configuration enabled"
          : payload
            ? "Approval required, scanning disabled"
            : "Database unavailable"}
      </span>
      {payload && (
        <form className="reddit-source-form" onSubmit={(event) => void addSource(event)}>
          <label htmlFor="reddit-subreddit">Add subreddit</label>
          <input
            id="reddit-subreddit"
            maxLength={23}
            onChange={(event) => setSubreddit(event.target.value)}
            placeholder="electronicmusic"
            required
            value={subreddit}
          />
          <button className="secondary-button" disabled={submitting} type="submit">
            <UserPlus size={14} /> Add source
          </button>
        </form>
      )}
      {payload?.sources.map((source) => (
        <div className="reddit-source-row" key={source.id}>
          <span>
            <strong>r/{source.subreddit}</strong>
            <small>
              {source.lastSuccessfulScanAt
                ? `Last scan ${new Date(source.lastSuccessfulScanAt).toLocaleString()}`
                : "Not scanned"}
            </small>
          </span>
          <button
            className="secondary-button"
            disabled={submitting}
            onClick={() => void updateSource(source.id, !source.enabled)}
            type="button"
          >
            {source.enabled ? "Pause" : "Enable"}
          </button>
          <button
            aria-label={`Remove r/${source.subreddit}`}
            className="icon-button destructive"
            disabled={submitting}
            onClick={() => void removeSource(source.id)}
            title={`Remove r/${source.subreddit}`}
            type="button"
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

const spotifyStatusSchema = z.object({
  displayName: z.string().nullable().optional(),
  lastTokenRefreshAt: z.string().nullable().optional(),
  scopes: z.array(z.string()).optional(),
  state: z.enum([
    "disabled",
    "missing_configuration",
    "disconnected",
    "connected",
    "reconnect_required",
  ]),
});

const importPreviewSchema = z.object({
  candidates: z.array(
    z.object({
      existingArtistId: z.string().uuid().nullable().optional(),
      id: z.string().uuid(),
      proposedAction: z.enum(["create", "merge", "review"]),
      providerName: z.string(),
      providerUrl: z.string().url(),
      selected: z.boolean(),
    }),
  ),
  importRunId: z.string().uuid(),
  retrieved: z.number().int().nonnegative(),
});

const importSummarySchema = z.object({
  created: z.number().int().nonnegative(),
  merged: z.number().int().nonnegative(),
  needsReview: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

function FeedItem({
  item,
  onItemChange,
  onSoundCloudLinkChange,
  soundCloudManualLinksEnabled,
  soundCloudLink,
}: {
  item: FeedFixtureItem;
  onItemChange: (id: string, changes: Partial<FeedFixtureItem>, message: string) => void;
  onSoundCloudLinkChange: (feedItemId: string, record?: SoundCloudLinkRecord) => void;
  soundCloudManualLinksEnabled: boolean;
  soundCloudLink: SoundCloudLinkRecord | undefined;
}) {
  const stateLabel = item.state === "needs_review" ? "Needs review" : titleCase(item.state);
  return (
    <article className="feed-item">
      <div className={`cover cover-${item.accent}`} aria-hidden="true">
        {item.releaseType === "ep" ? (
          <Disc3 size={30} />
        ) : item.releaseType === "feature" ? (
          <Sparkles size={29} />
        ) : (
          <Radio size={29} />
        )}
        <span>{item.artist.slice(0, 2).toLocaleUpperCase("en-US")}</span>
      </div>

      <div className="item-main">
        <div className="item-title-row">
          <div>
            <div className="badges">
              <span className={`state state-${item.state}`}>{stateLabel}</span>
              <span>{titleCase(item.releaseType)}</span>
            </div>
            <h2>{item.title}</h2>
            <p className="artist">{item.artist}</p>
          </div>
          <div className="item-actions">
            <button
              className="icon-button small"
              title="Save"
              aria-label={`Save ${item.title}`}
              onClick={() => onItemChange(item.id, { state: "saved" }, `${item.title} was saved.`)}
            >
              <Bookmark size={16} />
            </button>
            <button
              className="icon-button small"
              title="Mark listened"
              aria-label={`Mark ${item.title} listened`}
              onClick={() =>
                onItemChange(item.id, { state: "listened" }, `${item.title} was marked listened.`)
              }
            >
              <Headphones size={16} />
            </button>
            <button
              className="icon-button small"
              title="Dismiss"
              aria-label={`Dismiss ${item.title}`}
              onClick={() =>
                onItemChange(item.id, { state: "dismissed" }, `${item.title} was dismissed.`)
              }
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="item-facts">
          <span>
            <Disc3 size={14} /> {item.releaseTitle}
          </span>
          <span>
            <Clock3 size={14} /> Released {formatDate(item.releaseDate)}
            {item.releaseDatePrecision ? ` (${item.releaseDatePrecision} precision)` : ""}
          </span>
          <span>First seen {formatTimestamp(item.firstSeenAt)}</span>
          <span>{item.region}</span>
        </div>

        <div className="evidence-row">
          <div className="source-stack">
            {item.sources.map((source) => (
              <a href={source.href} key={source.provider} rel="noopener noreferrer" target="_blank">
                {source.provider}
                <ExternalLink size={12} />
              </a>
            ))}
          </div>
          <span className={`availability availability-${item.spotify}`}>
            Spotify {item.spotify}
          </span>
          {soundCloudManualLinksEnabled && (
            <span className="availability availability-unavailable">
              SoundCloud {soundCloudStateLabel(soundCloudLink?.state ?? item.soundcloudState)}
            </span>
          )}
        </div>

        {soundCloudManualLinksEnabled && (
          <SoundCloudReleaseControls
            item={item}
            onChange={onSoundCloudLinkChange}
            record={soundCloudLink}
          />
        )}

        <div className="match-row">
          <div className="confidence">
            <span style={{ width: `${item.confidence * 100}%` }} />
          </div>
          <strong>{Math.round(item.confidence * 100)}% match</strong>
          <span>{item.matchReason}</span>
          <a href={item.links[0]?.href} rel="noopener noreferrer" target="_blank">
            Evidence <ChevronRight size={13} />
          </a>
        </div>
      </div>

      <div className="export-column">
        <span>Playlist export</span>
        <strong className={`export-${item.exportStatus}`}>{exportLabel(item.exportStatus)}</strong>
        {item.exportStatus === "eligible" && (
          <button
            aria-label={`Export ${item.title}`}
            className="export-action-button"
            title="Export to Spotify mock playlist"
            onClick={() =>
              onItemChange(
                item.id,
                { exportStatus: "exported" },
                `${item.title} was added to the Spotify mock playlist.`,
              )
            }
          >
            <ListMusic size={15} />
          </button>
        )}
      </div>
    </article>
  );
}

function SoundCloudReleaseControls({
  item,
  onChange,
  record,
}: {
  item: FeedFixtureItem;
  onChange: (feedItemId: string, record?: SoundCloudLinkRecord) => void;
  record: SoundCloudLinkRecord | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(record?.url ?? "");
  const [error, setError] = useState<string | null>(null);
  const version = versionFromTitle(item.releaseTitle);
  const searchUrl = buildSoundCloudSearchUrl({
    artist: item.artist,
    title: item.title,
    ...(version ? { version } : {}),
  });

  const submitLink = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = validateSoundCloudUrl(url, "track");
    if (!result.valid || !result.normalizedUrl) {
      setError(result.error ?? "Enter a valid SoundCloud track URL.");
      return;
    }
    onChange(item.id, {
      feedItemId: item.id,
      state: "USER_LINKED_UNVERIFIED",
      url: result.normalizedUrl,
    });
    setEditing(false);
    setError(null);
  };

  return (
    <div className="soundcloud-controls">
      <div className="soundcloud-actions">
        <a
          aria-label={`Search SoundCloud for ${item.title}`}
          href={searchUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          <Search size={13} /> Search SoundCloud
        </a>
        <button
          aria-expanded={editing}
          className="text-button"
          onClick={() => {
            setEditing((value) => !value);
            setUrl(record?.url ?? "");
            setError(null);
          }}
        >
          <Link2 size={13} /> {record ? "Edit SoundCloud link" : "Paste SoundCloud track URL"}
        </button>
        {record?.state === "USER_LINKED_UNVERIFIED" && (
          <>
            <button
              className="text-button success-text"
              onClick={() =>
                onChange(item.id, {
                  ...record,
                  state: "USER_LINKED_VERIFIED",
                  verifier: "Local owner",
                  verifiedAt: new Date().toISOString(),
                })
              }
            >
              <Check size={13} /> Mark verified
            </button>
            <button
              className="text-button destructive-text"
              onClick={() =>
                onChange(item.id, {
                  ...record,
                  rejectedAt: new Date().toISOString(),
                  state: "USER_LINK_REJECTED",
                })
              }
            >
              <X size={13} /> Reject link
            </button>
          </>
        )}
        {record?.state === "USER_LINKED_VERIFIED" && (
          <a href={record.url} rel="noopener noreferrer" target="_blank">
            <ExternalLink size={13} /> Open on SoundCloud
          </a>
        )}
        {record && (
          <button className="text-button destructive-text" onClick={() => onChange(item.id)}>
            <Trash2 size={13} /> Remove link
          </button>
        )}
      </div>

      {editing && (
        <form className="soundcloud-link-form" onSubmit={submitLink}>
          <label htmlFor={`soundcloud-${item.id}`}>Exact SoundCloud track URL</label>
          <input
            id={`soundcloud-${item.id}`}
            onChange={(event) => {
              setUrl(event.target.value);
              setError(null);
            }}
            placeholder="https://soundcloud.com/artist/track"
            value={url}
          />
          <button className="primary-button" type="submit">
            Save unverified link
          </button>
          <button className="secondary-button" onClick={() => setEditing(false)} type="button">
            Cancel
          </button>
          {error && <span className="form-error">{error}</span>}
          <small>No SoundCloud page or metadata will be fetched.</small>
        </form>
      )}
    </div>
  );
}

function soundCloudStateLabel(state: FeedFixtureItem["soundcloudState"]): string {
  const labels = {
    NOT_CHECKED: "not checked",
    SEARCH_LINK_AVAILABLE: "search link available",
    USER_LINKED_UNVERIFIED: "link unverified",
    USER_LINKED_VERIFIED: "link verified",
    USER_LINK_REJECTED: "link rejected",
  } as const;
  return labels[state];
}

function versionFromTitle(title: string): string | undefined {
  return title.match(/\(([^)]+)\)/)?.[1];
}

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toLocaleUpperCase("en-US"));
}

function formatDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${month}/${day}/${year}`;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(value));
}

function exportLabel(status: FeedFixtureItem["exportStatus"]): string {
  const labels = {
    eligible: "Ready",
    exported: "Exported",
    blocked: "Not available",
    review_required: "Review required",
  } as const;
  return labels[status];
}
