"use client";

import {
  type FeedFixtureItem,
  type FeedState,
  type SoundCloudLinkRecord,
  buildSoundCloudSearchUrl,
  feedStates,
  normalizeAppleMusicAlbumUrl,
  normalizeAppleMusicArtworkUrl,
  normalizeSpotifyAlbumUrl,
  normalizeSpotifyArtworkUrl,
  releaseTypes,
  soundCloudLinkStates,
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import type { WatchlistArtistViewModel } from "../lib/watchlist-types";
import type { SpotifyPlaylistDashboardSummary } from "../lib/playlist-summary-server";

interface RadarShellProps {
  feedMode: "database" | "error" | "mock";
  initialArtists: WatchlistArtistViewModel[];
  initialFeedHasMore: boolean;
  initialFeedNextCursor: string | null;
  initialFeedRevision: string | null;
  initialFeedSummary: FeedSummary;
  initialFeedTotalCount: number;
  initialItems: FeedFixtureItem[];
  initialPlaylistSummary: SpotifyPlaylistDashboardSummary;
  providerConfiguration: ProviderUiConfiguration;
  scannedItem: FeedFixtureItem;
  watchlistMode: "database" | "error" | "mock";
}

interface FeedSummary {
  needsReview: number;
  newThisWeek: number;
  upcoming: number;
}

interface ProviderUiConfiguration {
  appleMusic: { configured: boolean; enabled: boolean };
  databaseConfigured: boolean;
  musicbrainz: { configured: boolean; enabled: boolean };
  soundcloudManualLinksEnabled: boolean;
  spotify: {
    allowedPlaylistConfigured: boolean;
    allowedPlaylistIdAbbreviated?: string;
    configured: boolean;
    enabled: boolean;
    expectedPlaylistPublic: boolean;
    minRequestIntervalMs: number;
    playlistWritesEnabled: boolean;
  };
}

type AppView =
  | "feed"
  | "artists"
  | "exports"
  | "soundcloud-links"
  | "review"
  | "history"
  | "status"
  | "settings";
type ArtistSort = "name-asc" | "name-desc" | "recent";
type ThemePreference = "system" | "light" | "dark";
type FeedPreference = "saved" | "listened";
type ReleaseReviewDecision =
  "confirm" | "confirm_track" | "defer" | "no_equivalent" | "retry" | "separate";

interface StreamingSourceDefinition {
  id: string;
  label: string;
  sourcePrefixes: string[];
}

const streamingSourceDefinitions: StreamingSourceDefinition[] = [
  { id: "spotify", label: "Spotify", sourcePrefixes: ["spotify"] },
  { id: "soundcloud", label: "SoundCloud", sourcePrefixes: ["soundcloud"] },
];

function hasSpotifyMatch(item: FeedFixtureItem): boolean {
  return (
    item.spotify === "playable" ||
    item.sources.some((source) => source.provider.toLocaleLowerCase("en-US") === "spotify")
  );
}

interface FeedAdvancedFilters {
  artist: string;
  dateFrom: string;
  dateTo: string;
  releaseType: string;
  sort: "release" | "first-seen";
  spotify: "all" | "available" | "unavailable";
  provider: "all" | "apple_music" | "musicbrainz" | "spotify" | "mock";
}

interface WatchedArtist {
  active: boolean;
  addedAt: number;
  id: string;
  manuallyAdded: boolean;
  name: string;
  providers: string[];
  releases: FeedFixtureItem[];
  source: string;
  spotifyCoverage?: {
    catalogPagesCompleted: number;
    dailyScanCompletedAt: string | null;
    lastFullReconciliationAt: string | null;
    nextOffset: number;
    pagesScannedInCycle: number;
    partial: boolean;
    status: string;
  } | null;
}

interface ImportSummary {
  alreadyPresent: number;
  created: number;
  failed: number;
  merged: number;
  needsReview: number;
  persisted: number;
  retrieved: number;
  selected: number;
  skipped: number;
}

interface ScanRunStatus {
  completedAt: string | null;
  id: string;
  insertedCount: number;
  provider: string | null;
  providersCompleted: string[];
  providersFailed: string[];
  providersRequested: string[];
  startedAt: string;
  status: "running" | "completed" | "partial" | "failed" | "cancelled" | "paused" | "rate_limited";
}

interface ScanHistoryEntry {
  artistCount: number | null;
  artistFilter: string | null;
  batchId: string | null;
  batchMode: string | null;
  completedAt: string | null;
  createdCount: number;
  dryRun: boolean;
  failureCount: number | null;
  id: string;
  partialArtistCount: number | null;
  provider: string | null;
  providersRequested: string[];
  requestCount: number | null;
  reviewCount: number;
  startedAt: string;
  status: string;
  triggerType: string;
  updatedCount: number;
}

interface ActiveScanStatus {
  cancelRequested: boolean;
  completedUnits: number;
  currentProvider: string | null;
  currentUnit: string | null;
  currentStage: string | null;
  expiresAt: string;
  heartbeatAt: string | null;
  lastPersistedResult: string | null;
  phase: string | null;
  providersCompleted: string[];
  providersFailed: string[];
  providersRequested: string[];
  rateLimitWaitMs: number;
  requests: number;
  retryAfterMs: number;
  startedAt: string;
  totalUnits: number;
}

interface ScanApiStatus {
  active: ActiveScanStatus | null;
  defaultHistoryId: string | null;
  discoverySchedule: DiscoveryScheduleStatus;
  history: ScanHistoryEntry[];
  historyHasMore: boolean;
  historyNextCursor: string | null;
  latest: ScanRunStatus | null;
  running: boolean;
  runs: ScanRunStatus[];
  musicbrainz: {
    batch: {
      cancelledArtists: number;
      completedArtists: number;
      failedArtists: number;
      id: string;
      status: string;
      totalArtists: number;
    } | null;
    operational: {
      lastRequestStartedAt: string | null;
      nextRequestAt: string | null;
      queueDepth: number;
      requestCount: number;
    };
  };
  spotify: {
    batch: SpotifyBatchStatus | null;
    coverage: {
      currentCycleCompletedPages: number;
      estimatedRemainingPages: number;
      estimatedRemainingRequests: number;
      failedArtists: number;
      fullyReconciledArtists: number;
      inProgressArtists: number;
      partialArtists: number;
      pausedArtists: number;
      queuedArtists: number;
      rateLimitedArtists: number;
      totalArtists: number;
    };
    limiter: {
      artistsPerBatch: number;
      batchPauseSeconds: number;
      distributionHours: number;
      maxRequestsPerRun: number;
      minRequestIntervalMs: number;
      reconciliationArtistsPerBatch: number;
      reconciliationCycleDays: number;
      reconciliationMaxPagesPerRun: number;
    };
    operational: SpotifyOperationalStatus;
    scheduler?: SpotifySchedulerStatus | undefined;
  };
}

interface DiscoveryScheduleJobStatus {
  appleMusicBatchId: string | null;
  batchCompletedArtists: number | null;
  batchFailedArtists: number | null;
  batchTotalArtists: number | null;
  completedAt: string | null;
  errorClassification: string | null;
  jobType: "apple_full" | "apple_catchup";
  recoveryDeadline: string;
  scheduledFor: string;
  status: "scheduled" | "leased" | "completed" | "failed" | "expired";
}

interface DiscoveryScheduleStatus {
  catchup: { latest: DiscoveryScheduleJobStatus | null; next: DiscoveryScheduleJobStatus | null };
  full: { latest: DiscoveryScheduleJobStatus | null; next: DiscoveryScheduleJobStatus | null };
  phase:
    | "idle"
    | "cooldown_wait"
    | "playlist_inbox"
    | "apple_priority"
    | "apple_catchup_priority"
    | "broad_spotify"
    | "weekly_apple";
  playlistInbox: {
    exportRunId: string | null;
    pendingCount: number;
    status: "pending" | "ready" | "exporting" | "partial" | "completed" | "failed";
  };
  timezone: "America/Los_Angeles";
}

interface SpotifySchedulerStatus {
  activeLease: {
    artistId: string | null;
    expiresAt: string;
    workId: string;
    workType: "base_artist" | "release_detail" | "release_tracks" | "artist_reconciliation";
  } | null;
  artistsCheckedLast24Hours: number;
  artistsCheckedLastHour: number;
  appleCatchupPriorityCount: number;
  applePriorityCount: number;
  backlog: Record<
    "base_artist" | "release_detail" | "release_tracks" | "artist_reconciliation",
    number
  >;
  blockedCount: number;
  blockedReasons: string[];
  cooldownActive: boolean;
  cooldownUntil: string | null;
  dailyBudget: {
    broadArtistsLimit: number;
    broadArtistsUsed: number;
    broadRequestsLimit: number;
    broadRequestsUsed: number;
    localDate: string;
    playlistRequestReserve: number;
    priorityRequestReserve: number;
  };
  dueArtistCount: number;
  eligibleArtistCount: number;
  estimatedCompletion: {
    earliest: string | null;
    latest: string | null;
    state: "available" | "blocked";
  };
  endpointBudget: {
    artistAlbums: {
      allowance: number;
      broadAllowance: number;
      broadRemaining: number;
      broadUsed: number;
      calls: number;
      nextCapacityAt: string | null;
      priorityRemaining: number;
      priorityReserve: number;
      priorityUsed: number;
      remaining: number;
      reserveRemaining: number;
      reserveReleased: boolean;
    };
    playlist: { reads: number; writes: number };
  };
  http429Last24Hours: number;
  lastQuotaExceeded: {
    cooldownUntil: string | null;
    endpointCategory: string;
    observedAt: string;
  } | null;
  mode: "disabled" | "planning" | "validation" | "automatic" | "paused";
  nextBaseSlotAt: string | null;
  oldestOverdueAgeMs: number | null;
  overdueArtistCount: number;
  partialArtistCount: number;
  requestCounts: {
    byEndpointCategory: Record<
      | "artist_albums"
      | "album_detail"
      | "album_tracks"
      | "playlist_read"
      | "playlist_write"
      | "oauth_or_other",
      number
    >;
    byWorkType: {
      artist_reconciliation?: number | undefined;
      base_artist?: number | undefined;
      release_detail?: number | undefined;
      release_tracks?: number | undefined;
    };
    last24Hours: number;
    last30Minutes: number;
  };
  recentWork: {
    artistId: string | null;
    completedAt: string;
    workId: string;
    workType: "base_artist" | "release_detail" | "release_tracks" | "artist_reconciliation";
  } | null;
  targetArtistCount: number;
}

interface SpotifyOperationalStatus {
  canManualClear: boolean;
  cooldownActive: boolean;
  cooldownEndpointCategory: string | null;
  cooldownErrorClassification: string | null;
  cooldownIndefinite: boolean;
  cooldownObservedAt: string | null;
  cooldownUntil: string | null;
  lastRequestStartedAt: string | null;
  nextRequestAt: string | null;
  parsedRetryAfterSeconds: string | null;
  queueDepth: number;
  rawRetryAfter: string | null;
  requestCount: number;
}

interface SpotifyArtistScanStatus {
  artistId: string;
  errorClassification: string | null;
  id: string;
  position: number;
  status: string;
}

interface SpotifyBatchStatus {
  blockedMappingArtists: number;
  cancelledArtists: number;
  completedArtists: number;
  confirmationRequired: boolean;
  estimatedRequests: number;
  failedArtists: number;
  id: string;
  mode: string;
  pageLimit: number;
  partialArtists: number;
  rateLimitedArtists: number;
  status: string;
  totalArtists: number;
  artistScans: SpotifyArtistScanStatus[];
}

const filters: Array<{ state: FeedState | "all"; label: string }> = [
  { state: "new", label: "New" },
  { state: "all", label: "All" },
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
  "history",
  "status",
  "settings",
]);

export function RadarShell({
  feedMode,
  initialArtists,
  initialFeedHasMore,
  initialFeedNextCursor,
  initialFeedRevision,
  initialFeedSummary,
  initialFeedTotalCount,
  initialItems,
  initialPlaylistSummary,
  providerConfiguration,
  scannedItem,
  watchlistMode,
}: RadarShellProps) {
  const [activeView, setActiveView] = useState<AppView>("feed");
  const reviewFeedMode = activeView === "review";
  const [hydrated, setHydrated] = useState(false);
  const [activeFilter, setActiveFilter] = useState<FeedState | "all">("new");
  const [items, setItems] = useState(initialItems);
  const itemsRef = useRef(initialItems);
  const feedRevisionRef = useRef(initialFeedRevision);
  const initialFeedQueryRef = useRef(true);
  const feedRefreshInFlightRef = useRef(false);
  const [feedHasMore, setFeedHasMore] = useState(initialFeedHasMore);
  const [feedNextCursor, setFeedNextCursor] = useState(initialFeedNextCursor);
  const [feedTotalCount, setFeedTotalCount] = useState(initialFeedTotalCount);
  const [feedSummary, setFeedSummary] = useState(initialFeedSummary);
  const [feedPageState, setFeedPageState] = useState<"idle" | "loading" | "error">("idle");
  const [feedRefreshState, setFeedRefreshState] = useState<
    "idle" | "checking" | "updated" | "error"
  >("idle");
  const [feedRefreshMessage, setFeedRefreshMessage] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [mockLastScanInsertedCount, setMockLastScanInsertedCount] = useState(0);
  const [pendingFeedActions, setPendingFeedActions] = useState<string[]>([]);
  const [pendingReviewActions, setPendingReviewActions] = useState<string[]>([]);
  const [cancellingScan, setCancellingScan] = useState(false);
  const [scanStatus, setScanStatus] = useState<ScanApiStatus | null>(null);
  const [scanStatusState, setScanStatusState] = useState<"idle" | "loading" | "loaded" | "error">(
    "idle",
  );
  const [loadingOlderHistory, setLoadingOlderHistory] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [exactOnly, setExactOnly] = useState(false);
  const [advancedFilters, setAdvancedFilters] = useState<FeedAdvancedFilters>({
    artist: "all",
    dateFrom: "",
    dateTo: "",
    releaseType: "all",
    sort: "release",
    spotify: "all",
    provider: "all",
  });
  const [notice, setNotice] = useState<string | null>(null);
  const [dailyScan, setDailyScan] = useState(true);
  const [digest, setDigest] = useState(false);
  const [themePreference, setThemePreference] = useState<ThemePreference | null>(null);
  const [persistedArtists, setPersistedArtists] = useState(initialArtists);
  const [activeWatchlistMode, setActiveWatchlistMode] = useState(watchlistMode);
  const [addedArtists, setAddedArtists] = useState<WatchedArtist[]>([]);
  const [artistNames, setArtistNames] = useState<Record<string, string>>({});
  const [removedArtistIds, setRemovedArtistIds] = useState<string[]>([]);
  const [artistProfiles, setArtistProfiles] = useState<Record<string, string>>({});
  const [soundCloudLinks, setSoundCloudLinks] = useState<Record<string, SoundCloudLinkRecord>>({});

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

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
    const completedNotice = window.sessionStorage.getItem("ts-radar-scan-notice");
    if (!completedNotice) return;
    window.sessionStorage.removeItem("ts-radar-scan-notice");
    setNotice(completedNotice);
  }, []);

  useEffect(() => {
    if (feedMode !== "database") return;
    let cancelled = false;
    const loadScanStatus = async () => {
      if (!cancelled) setScanStatusState((current) => (current === "idle" ? "loading" : current));
      try {
        const response = await fetch("/api/scans", { cache: "no-store" });
        const status = scanStatusSchema.parse(await response.json());
        if (!cancelled && response.ok) {
          setScanStatus((current) =>
            current && current.history.length > status.history.length
              ? {
                  ...status,
                  history: mergeById(status.history, current.history),
                  historyHasMore: current.historyHasMore,
                  historyNextCursor: current.historyNextCursor,
                }
              : status,
          );
          setScanStatusState("loaded");
        }
      } catch {
        if (!cancelled) setScanStatusState("error");
      }
    };
    void loadScanStatus();
    const interval = window.setInterval(() => void loadScanStatus(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [feedMode]);

  const loadOlderScanHistory = async () => {
    const cursor = scanStatus?.historyNextCursor;
    if (!cursor || loadingOlderHistory) return;
    setLoadingOlderHistory(true);
    try {
      const parameters = new URLSearchParams({ historyCursor: cursor, historyLimit: "20" });
      const response = await fetch(`/api/scans?${parameters.toString()}`, { cache: "no-store" });
      const page = scanStatusSchema.parse(await response.json());
      if (!response.ok) throw new Error("Scan history page failed");
      setScanStatus((current) =>
        current
          ? {
              ...current,
              history: mergeById(current.history, page.history),
              historyHasMore: page.historyHasMore,
              historyNextCursor: page.historyNextCursor,
            }
          : page,
      );
    } catch {
      setNotice("Older scan history could not be loaded.");
    } finally {
      setLoadingOlderHistory(false);
    }
  };

  useEffect(() => {
    if (!scanStatus?.running) setCancellingScan(false);
  }, [scanStatus?.running]);

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

  const feedQueryParameters = useCallback(
    (cursor?: string) => {
      const parameters = new URLSearchParams({ limit: "100", sort: advancedFilters.sort });
      const state = reviewFeedMode ? "needs_review" : activeFilter;
      if (state !== "all") parameters.set("state", state);
      const normalizedQuery = query.trim();
      if (normalizedQuery) parameters.set("search", normalizedQuery);
      if (exactOnly) parameters.set("exactOnly", "true");
      if (advancedFilters.artist !== "all") parameters.set("artist", advancedFilters.artist);
      if (advancedFilters.dateFrom) parameters.set("dateFrom", advancedFilters.dateFrom);
      if (advancedFilters.dateTo) parameters.set("dateTo", advancedFilters.dateTo);
      if (advancedFilters.provider !== "all") {
        parameters.set("provider", advancedFilters.provider);
      }
      if (advancedFilters.releaseType !== "all") {
        parameters.set("releaseType", advancedFilters.releaseType);
      }
      if (advancedFilters.spotify !== "all") {
        parameters.set("spotify", advancedFilters.spotify);
      }
      if (cursor) parameters.set("cursor", cursor);
      return parameters;
    },
    [activeFilter, advancedFilters, exactOnly, query, reviewFeedMode],
  );

  const loadFeedPage = useCallback(
    async ({ append = false, cursor }: { append?: boolean; cursor?: string } = {}) => {
      if (feedMode !== "database" || feedRefreshInFlightRef.current) return false;
      feedRefreshInFlightRef.current = true;
      setFeedPageState("loading");
      try {
        const response = await fetch(`/api/feed?${feedQueryParameters(cursor).toString()}`, {
          cache: "no-store",
        });
        const page = feedSnapshotResponseSchema.parse(await response.json());
        if (!response.ok) throw new Error("Feed page failed");
        const incoming = page.items as FeedFixtureItem[];
        const nextItems = append ? mergeFeedItems(itemsRef.current, incoming) : incoming;
        itemsRef.current = nextItems;
        feedRevisionRef.current = page.revision;
        setItems(nextItems);
        setFeedHasMore(page.hasMore);
        setFeedNextCursor(page.nextCursor);
        setFeedTotalCount(page.totalCount);
        setFeedSummary(page.summary);
        setFeedPageState("idle");
        return true;
      } catch {
        setFeedPageState("error");
        return false;
      } finally {
        feedRefreshInFlightRef.current = false;
      }
    },
    [feedMode, feedQueryParameters],
  );

  const refreshDatabaseFeed = useCallback(
    async ({ force = false }: { force?: boolean } = {}) => {
      if (feedMode !== "database" || feedRefreshInFlightRef.current) return false;
      if (force) {
        setFeedRefreshState("checking");
        const refreshed = await loadFeedPage();
        setFeedRefreshState(refreshed ? "updated" : "error");
        setFeedRefreshMessage(
          refreshed
            ? "Feed refreshed from the top."
            : "Feed refresh failed. Existing discoveries remain available.",
        );
        return refreshed;
      }
      feedRefreshInFlightRef.current = true;
      try {
        const revisionResponse = await fetch("/api/feed?mode=revision", { cache: "no-store" });
        const revision = feedRevisionResponseSchema.parse(await revisionResponse.json());
        if (!revisionResponse.ok) throw new Error("Feed revision check failed");
        if (feedRevisionRef.current === revision.revision) return false;
        setFeedRefreshState("updated");
        setFeedRefreshMessage("New or updated releases are available. Refresh from the top.");
        return true;
      } catch {
        setFeedRefreshState("error");
        setFeedRefreshMessage("Feed update check failed. Existing discoveries remain available.");
        return false;
      } finally {
        feedRefreshInFlightRef.current = false;
      }
    },
    [feedMode, loadFeedPage],
  );

  useEffect(() => {
    if (feedMode !== "database") return;
    const checkForChanges = () => {
      if (document.visibilityState === "visible") void refreshDatabaseFeed();
    };
    if (!feedRevisionRef.current) checkForChanges();
    const interval = window.setInterval(checkForChanges, 15_000);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void refreshDatabaseFeed();
    };
    window.addEventListener("focus", checkForChanges);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", checkForChanges);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [feedMode, refreshDatabaseFeed]);

  useEffect(() => {
    if (feedMode !== "database") return;
    if (initialFeedQueryRef.current) {
      initialFeedQueryRef.current = false;
      return;
    }
    const timeout = window.setTimeout(() => {
      setFeedRefreshMessage(null);
      void loadFeedPage();
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [feedMode, feedQueryParameters, loadFeedPage]);

  const visibleItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
    if (feedMode === "database") return items;
    return items
      .filter((item) => {
        const stateMatches =
          activeFilter === "all" ||
          (activeFilter === "saved"
            ? item.saved
            : activeFilter === "listened"
              ? item.listened
              : item.state === activeFilter);
        const queryMatches =
          !normalizedQuery ||
          `${item.artist} ${item.title} ${item.releaseTitle}`
            .toLocaleLowerCase("en-US")
            .includes(normalizedQuery);
        const confidenceMatches = !exactOnly || item.confidence === 1;
        const spotifyMatches =
          advancedFilters.spotify === "all" ||
          (advancedFilters.spotify === "available"
            ? hasSpotifyMatch(item)
            : !hasSpotifyMatch(item));
        const releaseTypeMatches =
          advancedFilters.releaseType === "all" || item.releaseType === advancedFilters.releaseType;
        const artistMatches =
          advancedFilters.artist === "all" || item.artist === advancedFilters.artist;
        const dateMatches =
          (!advancedFilters.dateFrom || item.releaseDate >= advancedFilters.dateFrom) &&
          (!advancedFilters.dateTo || item.releaseDate <= advancedFilters.dateTo);
        const providerMatches =
          advancedFilters.provider === "all" ||
          item.sources.some((source) =>
            source.provider.toLocaleLowerCase("en-US").startsWith(advancedFilters.provider),
          );
        return (
          stateMatches &&
          queryMatches &&
          confidenceMatches &&
          spotifyMatches &&
          releaseTypeMatches &&
          artistMatches &&
          dateMatches &&
          providerMatches
        );
      })
      .sort((left, right) => {
        const primary =
          advancedFilters.sort === "release"
            ? right.releaseDate.localeCompare(left.releaseDate)
            : Date.parse(right.firstSeenAt) - Date.parse(left.firstSeenAt);
        return primary || Date.parse(right.firstSeenAt) - Date.parse(left.firstSeenAt);
      });
  }, [activeFilter, advancedFilters, exactOnly, feedMode, items, query]);

  const reviewItems = items.filter(
    (item) =>
      item.state === "needs_review" &&
      (!item.review?.deferredUntil || Date.parse(item.review.deferredUntil) <= Date.now()),
  );
  const verifiedSoundCloudLinks = Object.values(soundCloudLinks).filter(
    (link) => link.state === "USER_LINKED_VERIFIED",
  );
  const fixtureArtists: WatchedArtist[] = Array.from(
    new Set(initialItems.map((item) => item.artist)),
  ).map((artist) => {
    const releases = items.filter((item) => item.artist === artist);
    const id = `fixture:${artist.toLocaleLowerCase("en-US")}`;
    return {
      active: true,
      addedAt: Math.max(...releases.map((release) => Date.parse(release.firstSeenAt))),
      id,
      manuallyAdded: false,
      name: artistNames[id] ?? artist,
      providers: Array.from(
        new Set(releases.flatMap((release) => release.sources.map((source) => source.provider))),
      ),
      releases,
      source: "mock",
    };
  });
  const databaseArtists: WatchedArtist[] = persistedArtists.map((artist) => ({
    active: artist.active,
    addedAt: Date.parse(artist.addedAt),
    id: artist.id,
    manuallyAdded: artist.source === "manual",
    name: artistNames[artist.id] ?? artist.name,
    providers: artist.providers,
    releases: items.filter((item) => item.artist === artist.name),
    source: artist.source,
    spotifyCoverage: artist.spotifyCoverage,
  }));
  const artists: WatchedArtist[] = [
    ...(activeWatchlistMode === "mock" ? fixtureArtists : databaseArtists),
    ...addedArtists.map((artist) => ({ ...artist, name: artistNames[artist.id] ?? artist.name })),
  ].filter((artist) => !removedArtistIds.includes(artist.id));

  const navigate = (view: AppView) => {
    setActiveView(view);
    setNotice(null);
    window.history.replaceState(null, "", `#${view}`);
  };

  const refreshPersistedWatchlist = async () => {
    const response = await fetch("/api/artists", { cache: "no-store" });
    const body = watchlistResponseSchema.parse(await response.json());
    if (!response.ok) throw new Error("Unable to refresh followed artists");
    setPersistedArtists(body.artists);
    setActiveWatchlistMode("database");
    return body;
  };

  const refreshWatchlistAfterImport = async (summary: ImportSummary) => {
    try {
      const body = await refreshPersistedWatchlist();
      setActiveView("artists");
      window.history.replaceState(null, "", "#artists");
      setNotice(
        `Spotify import persisted ${body.activeCount} active artists: ${summary.created} created, ${summary.merged} merged, ${summary.alreadyPresent} already present.`,
      );
    } catch {
      setActiveView("artists");
      window.history.replaceState(null, "", "#artists");
      setNotice(
        `Spotify import was persisted, but the watchlist refresh failed. Reload the page to view ${summary.persisted} active artists.`,
      );
    }
  };

  const updateItem = (id: string, changes: Partial<FeedFixtureItem>, message: string) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...changes } : item)));
    setNotice(message);
  };

  const toggleFeedPreference = async (item: FeedFixtureItem, preference: FeedPreference) => {
    const actionKey = `${item.id}:${preference}`;
    if (pendingFeedActions.includes(actionKey)) return;
    const nextValue = !item[preference];
    setPendingFeedActions((current) => [...current, actionKey]);
    setItems((current) =>
      current.map((currentItem) =>
        currentItem.id === item.id ? { ...currentItem, [preference]: nextValue } : currentItem,
      ),
    );

    try {
      if (feedMode === "database") {
        const response = await fetch(`/api/feed-items/${encodeURIComponent(item.id)}`, {
          body: JSON.stringify({ [preference]: nextValue }),
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        });
        const body = feedPreferenceResponseSchema.parse(await response.json());
        if (!response.ok) throw new Error("Unable to persist feed preference");
        setItems((current) =>
          current.map((currentItem) =>
            currentItem.id === item.id
              ? {
                  ...currentItem,
                  listened: body.item.listened,
                  saved: body.item.saved,
                  state: body.item.state,
                }
              : currentItem,
          ),
        );
      }
      setNotice(
        preference === "saved"
          ? nextValue
            ? `${item.title} was saved.`
            : `${item.title} was removed from saved.`
          : nextValue
            ? `${item.title} was marked listened.`
            : `${item.title} was marked unlistened.`,
      );
    } catch {
      setItems((current) =>
        current.map((currentItem) =>
          currentItem.id === item.id
            ? { ...currentItem, [preference]: item[preference] }
            : currentItem,
        ),
      );
      setNotice(`Unable to update ${item.title}. Try again.`);
    } finally {
      setPendingFeedActions((current) => current.filter((key) => key !== actionKey));
    }
  };

  const resolveReviewItem = async (
    item: FeedFixtureItem,
    decision: ReleaseReviewDecision,
    spotifyTrackId?: string,
  ) => {
    if (pendingReviewActions.includes(item.id)) return;
    setPendingReviewActions((current) => [...current, item.id]);
    try {
      if (feedMode === "database") {
        const response = await fetch(`/api/feed-items/${encodeURIComponent(item.id)}`, {
          body: JSON.stringify({
            reviewDecision: decision,
            ...(spotifyTrackId ? { spotifyTrackId } : {}),
          }),
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        });
        reviewResolutionResponseSchema.parse(await response.json());
        if (!response.ok) throw new Error("Unable to persist review decision");
      }
      setItems((current) => current.filter((currentItem) => currentItem.id !== item.id));
      setNotice(
        decision === "confirm"
          ? `${item.title} was manually confirmed and removed from review.`
          : decision === "confirm_track"
            ? `${item.title} was queued for guarded verification against the selected Spotify track.`
            : decision === "retry"
              ? `${item.title} was queued for a fresh Spotify resolution attempt.`
              : decision === "defer"
                ? `${item.title} was deferred for seven days.`
                : decision === "no_equivalent"
                  ? `${item.title} was marked as having no Spotify equivalent.`
                  : `${item.title} was kept separate and removed from review.`,
      );
      if (feedMode === "database") await refreshDatabaseFeed({ force: true });
    } catch {
      setNotice(`Unable to resolve ${item.title}. Try again.`);
    } finally {
      setPendingReviewActions((current) => current.filter((id) => id !== item.id));
    }
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
        active: true,
        addedAt: Date.now(),
        id: `manual:${normalizedName.toLocaleLowerCase("en-US")}`,
        manuallyAdded: true,
        name: normalizedName,
        providers: [],
        releases: [],
        source: "manual",
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

  const runFeedScan = async (scanRequest?: {
    artistId?: string;
    musicbrainzBatchId?: string;
    provider?: "musicbrainz";
  }) => {
    if (feedMode === "error") {
      setNotice("The database is unavailable, so a scan cannot be started.");
      return;
    }
    if (feedMode === "database") {
      setCancellingScan(false);
      const existingRunIds = new Set(scanStatus?.runs.map((run) => run.id) ?? []);
      const existingRunningIds = new Set(
        scanStatus?.runs.filter((run) => run.status === "running").map((run) => run.id) ?? [],
      );
      setSyncing(true);
      setNotice(null);
      try {
        const musicbrainzOnly =
          providerConfiguration.musicbrainz.enabled && scanRequest?.provider === "musicbrainz";
        const response = await fetch("/api/scans", {
          ...(musicbrainzOnly
            ? {
                body: JSON.stringify({ provider: "musicbrainz", ...scanRequest }),
                headers: { "Content-Type": "application/json" },
              }
            : {}),
          method: "POST",
        });
        if (response.status === 409) {
          setNotice("A scan is already running. This page will continue monitoring it.");
        } else {
          const launch = scanLaunchSchema.parse(await response.json());
          if (!response.ok || !launch.accepted) throw new Error("Scan launch failed");
          setNotice(
            musicbrainzOnly
              ? "MusicBrainz-only release update started. Spotify remains untouched."
              : "Release update started. Configured providers will continue independently.",
          );
        }

        for (let attempt = 0; attempt < 900; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 2_000));
          const statusResponse = await fetch("/api/scans", { cache: "no-store" });
          const status = scanStatusSchema.parse(await statusResponse.json());
          if (!statusResponse.ok) throw new Error("Scan status failed");
          setScanStatus(status);
          const completedRuns = status.runs.filter(
            (run) =>
              (!existingRunIds.has(run.id) || existingRunningIds.has(run.id)) &&
              run.status !== "running",
          );
          if (!status.running && completedRuns.length > 0) {
            const inserted = completedRuns.reduce((total, run) => total + run.insertedCount, 0);
            const failed = completedRuns.filter(
              (run) => run.status === "failed" || run.status === "partial",
            ).length;
            const message = failed
              ? `Release update finished with ${failed} provider warning${failed === 1 ? "" : "s"}; ${inserted} discoveries were added.`
              : `Release update complete. ${inserted} new ${inserted === 1 ? "discovery" : "discoveries"} added.`;
            await refreshDatabaseFeed({ force: true });
            setNotice(message);
            return;
          }
        }
        throw new Error("Scan monitoring timed out");
      } catch {
        setNotice("The release update could not be started or monitored. Check System status.");
      } finally {
        setSyncing(false);
      }
      return;
    }

    setSyncing(true);
    setNotice(null);
    window.setTimeout(() => {
      setSyncing(false);
      setItems((current) => {
        if (current.some((item) => item.id === scannedItem.id)) {
          setMockLastScanInsertedCount(0);
          setNotice("Mock scan completed. No duplicate discoveries were added.");
          return current;
        }
        setMockLastScanInsertedCount(1);
        setNotice(`Mock scan completed. ${scannedItem.title} was added to the feed.`);
        return [scannedItem, ...current];
      });
    }, 700);
  };

  const cancelFeedScan = async () => {
    setCancellingScan(true);
    try {
      const response = await fetch("/api/scans", { method: "DELETE" });
      if (!response.ok) throw new Error("Scan cancellation failed");
      setNotice("Cancellation requested. The scanner will stop at the next safe checkpoint.");
      setScanStatus((current) =>
        current?.active
          ? { ...current, active: { ...current.active, cancelRequested: true } }
          : current,
      );
    } catch {
      setNotice("The scan cancellation request failed. Check System status.");
      setCancellingScan(false);
    }
  };

  const controlSpotifyBatch = async (
    action: "pause" | "resume" | "cancel" | "retry_artist" | "start_reconciliation",
    id: string,
  ) => {
    try {
      const response = await fetch("/api/spotify/scan-control", {
        body: JSON.stringify(
          action === "retry_artist"
            ? { action, artistScanId: id }
            : action === "start_reconciliation"
              ? { action, confirmed: true }
              : { action, batchId: id, ...(action === "resume" ? { confirmed: true } : {}) },
        ),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Spotify scan action failed");
      setNotice(
        action === "pause"
          ? "Spotify will pause after the current request."
          : action === "cancel"
            ? "Future Spotify batch work was cancelled. Completed results were preserved."
            : "Spotify batch processing was queued.",
      );
      const statusResponse = await fetch("/api/scans", { cache: "no-store" });
      if (statusResponse.ok) setScanStatus(scanStatusSchema.parse(await statusResponse.json()));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Spotify scan action failed.");
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Radio size={19} />
          </span>
          <span className="brand-name">
            <strong>TS NEW MUSIC SCANNER</strong>
          </span>
        </div>

        <PrimaryNavigation
          activeView={activeView}
          discoveryCount={feedMode === "database" ? feedTotalCount : items.length}
          artistCount={artists.length}
          reviewCount={feedMode === "database" ? feedSummary.needsReview : reviewItems.length}
          soundCloudManualLinksEnabled={providerConfiguration.soundcloudManualLinksEnabled}
          soundCloudLinkCount={verifiedSoundCloudLinks.length}
          navigate={navigate}
        />

        <div className="sidebar-section">
          <p>Sources</p>
          {[
            ...(feedMode === "mock"
              ? [{ provider: "mock", label: "Mock provider", connected: true }]
              : []),
            {
              provider: "apple_music",
              label: providerConfiguration.appleMusic.configured
                ? "Apple Music configured"
                : "Apple Music not configured",
              connected: providerConfiguration.appleMusic.configured,
            },
            {
              provider: "spotify",
              label: providerConfiguration.spotify.configured
                ? "Spotify configured"
                : "Spotify not configured",
              connected: providerConfiguration.spotify.configured,
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
              <strong>Personal scanner</strong>
              <small>
                {feedMode === "mock"
                  ? "Mock mode"
                  : feedMode === "database"
                    ? "Database mode"
                    : "Database unavailable"}
              </small>
            </div>
          </div>
        </div>
      </aside>

      <main className="main" id={activeView}>
        <header className="topbar">
          <div className="mobile-brand">
            <Radio size={18} /> TS NEW MUSIC SCANNER
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
            discoveryCount={feedMode === "database" ? feedTotalCount : items.length}
            artistCount={artists.length}
            reviewCount={feedMode === "database" ? feedSummary.needsReview : reviewItems.length}
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

        {(activeView === "feed" || activeView === "history") && (
          <FeedView
            activeFilter={activeFilter}
            advancedFilters={advancedFilters}
            exactOnly={exactOnly}
            feedMode={feedMode}
            feedHasMore={feedHasMore}
            feedPageState={feedPageState}
            filtersOpen={filtersOpen}
            items={visibleItems}
            lastScanInsertedCount={
              feedMode === "mock"
                ? mockLastScanInsertedCount
                : (scanStatus?.latest?.insertedCount ?? 0)
            }
            musicbrainzConfigured={providerConfiguration.musicbrainz.configured}
            musicbrainzEnabled={providerConfiguration.musicbrainz.enabled}
            soundCloudLinks={soundCloudLinks}
            onFilterChange={setActiveFilter}
            onAdvancedFiltersChange={setAdvancedFilters}
            onItemChange={updateItem}
            onLoadMore={() => {
              if (feedNextCursor) void loadFeedPage({ append: true, cursor: feedNextCursor });
            }}
            onTogglePreference={(item, preference) => void toggleFeedPreference(item, preference)}
            onSoundCloudLinkChange={changeSoundCloudLink}
            onToggleExact={() => setExactOnly((value) => !value)}
            onToggleFilters={() => setFiltersOpen((value) => !value)}
            onRunScan={() => void runFeedScan()}
            onRefreshFeed={() => void refreshDatabaseFeed({ force: true })}
            onRetryDatabase={() => window.location.reload()}
            onMusicBrainzResume={(batchId) =>
              void runFeedScan({ musicbrainzBatchId: batchId, provider: "musicbrainz" })
            }
            onLoadOlderHistory={() => void loadOlderScanHistory()}
            onCancelScan={() => void cancelFeedScan()}
            onSpotifyBatchAction={(action, id) => void controlSpotifyBatch(action, id)}
            pendingFeedActions={pendingFeedActions}
            ready={hydrated}
            reviewCount={feedMode === "database" ? feedSummary.needsReview : reviewItems.length}
            scanStatus={scanStatus}
            scanStatusState={scanStatusState}
            loadingOlderHistory={loadingOlderHistory}
            summaryItems={items}
            serverSummary={feedMode === "database" ? feedSummary : null}
            cancellingScan={cancellingScan}
            soundCloudManualLinksEnabled={providerConfiguration.soundcloudManualLinksEnabled}
            syncing={syncing}
            feedRefreshMessage={feedRefreshMessage}
            feedRefreshState={feedRefreshState}
            viewMode={activeView}
          />
        )}

        {activeView === "artists" && (
          <ArtistsView
            artistProfiles={artistProfiles}
            artists={artists}
            onAddArtist={addArtist}
            onEditArtist={editArtist}
            onNotice={setNotice}
            onRefreshArtists={async () => {
              await refreshPersistedWatchlist();
            }}
            onRemoveArtist={removeArtist}
            onRemoveProfile={removeArtistProfile}
            onSaveProfile={saveArtistProfile}
            onScanArtist={(artistId) => void runFeedScan({ artistId, provider: "musicbrainz" })}
            musicbrainzConfigured={providerConfiguration.musicbrainz.configured}
            musicbrainzEnabled={providerConfiguration.musicbrainz.enabled}
            soundCloudManualLinksEnabled={providerConfiguration.soundcloudManualLinksEnabled}
            watchlistMode={activeWatchlistMode}
          />
        )}
        {activeView === "exports" && (
          <ExportsView
            initialSummary={initialPlaylistSummary}
            items={items}
            onNotice={setNotice}
            spotifyConfiguration={providerConfiguration.spotify}
          />
        )}
        {activeView === "soundcloud-links" &&
          providerConfiguration.soundcloudManualLinksEnabled && (
            <SoundCloudLinksView items={items} links={verifiedSoundCloudLinks} />
          )}
        {activeView === "review" && (
          <ReviewView
            databaseMode={feedMode === "database"}
            items={reviewItems}
            musicbrainzEnabled={providerConfiguration.musicbrainz.enabled}
            onDecision={(item, decision, spotifyTrackId) =>
              void resolveReviewItem(item, decision, spotifyTrackId)
            }
            pendingItemIds={pendingReviewActions}
            query={query}
          />
        )}
        {activeView === "status" && <SystemStatusView />}
        {activeView === "settings" && (
          <SettingsView
            dailyScan={dailyScan}
            digest={digest}
            onDailyScanChange={setDailyScan}
            onDigestChange={setDigest}
            onImportConfirmed={refreshWatchlistAfterImport}
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
        active={activeView === "history"}
        icon={<Clock3 size={17} />}
        label="History and Schedules"
        onClick={() => navigate("history")}
        view="history"
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
  feedHasMore: boolean;
  feedPageState: "idle" | "loading" | "error";
  feedRefreshMessage: string | null;
  feedRefreshState: "idle" | "checking" | "updated" | "error";
  filtersOpen: boolean;
  items: FeedFixtureItem[];
  lastScanInsertedCount: number;
  musicbrainzConfigured: boolean;
  musicbrainzEnabled: boolean;
  soundCloudLinks: Record<string, SoundCloudLinkRecord>;
  onFilterChange: (state: FeedState | "all") => void;
  onAdvancedFiltersChange: (filters: FeedAdvancedFilters) => void;
  onItemChange: (id: string, changes: Partial<FeedFixtureItem>, message: string) => void;
  onLoadMore: () => void;
  onLoadOlderHistory: () => void;
  onTogglePreference: (item: FeedFixtureItem, preference: FeedPreference) => void;
  onSoundCloudLinkChange: (feedItemId: string, record?: SoundCloudLinkRecord) => void;
  onRunScan: () => void;
  onRefreshFeed: () => void;
  onRetryDatabase: () => void;
  onMusicBrainzResume: (batchId: string) => void;
  onCancelScan: () => void;
  onSpotifyBatchAction: (
    action: "pause" | "resume" | "cancel" | "retry_artist" | "start_reconciliation",
    id: string,
  ) => void;
  onToggleExact: () => void;
  onToggleFilters: () => void;
  pendingFeedActions: string[];
  ready: boolean;
  reviewCount: number;
  scanStatus: ScanApiStatus | null;
  scanStatusState: "idle" | "loading" | "loaded" | "error";
  serverSummary: FeedSummary | null;
  summaryItems: FeedFixtureItem[];
  cancellingScan: boolean;
  soundCloudManualLinksEnabled: boolean;
  syncing: boolean;
  loadingOlderHistory: boolean;
  viewMode: "feed" | "history";
}

function FeedView({
  activeFilter,
  advancedFilters,
  exactOnly,
  feedMode,
  feedHasMore,
  feedPageState,
  feedRefreshMessage,
  feedRefreshState,
  filtersOpen,
  items,
  lastScanInsertedCount,
  musicbrainzConfigured,
  musicbrainzEnabled,
  soundCloudLinks,
  onFilterChange,
  onAdvancedFiltersChange,
  onItemChange,
  onLoadMore,
  onLoadOlderHistory,
  onTogglePreference,
  onSoundCloudLinkChange,
  onRunScan,
  onRefreshFeed,
  onRetryDatabase,
  onMusicBrainzResume,
  onCancelScan,
  onSpotifyBatchAction,
  onToggleExact,
  onToggleFilters,
  pendingFeedActions,
  ready,
  reviewCount,
  scanStatus,
  scanStatusState,
  serverSummary,
  summaryItems,
  cancellingScan,
  soundCloudManualLinksEnabled,
  syncing,
  loadingOlderHistory,
  viewMode,
}: FeedViewProps) {
  const [collapsedReleaseGroups, setCollapsedReleaseGroups] = useState<string[]>([]);
  const [appleSchedulerCollapsed, setAppleSchedulerCollapsed] = useState(false);
  const [spotifySchedulerCollapsed, setSpotifySchedulerCollapsed] = useState(false);
  const [spotifyStatusCollapsed, setSpotifyStatusCollapsed] = useState(false);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const feedSummary = useMemo(
    () => serverSummary ?? calculateFeedSummary(summaryItems),
    [serverSummary, summaryItems],
  );
  const scanInProgress = syncing || Boolean(scanStatus?.running);
  const activeScan = scanStatus?.active;
  const spotifyOperational = scanStatus?.spotify.operational;
  const spotifyScheduler = scanStatus?.spotify.scheduler;
  const discoverySchedule = scanStatus?.discoverySchedule;
  const spotifyBatch = scanStatus?.spotify.batch;
  const musicbrainzBatch = musicbrainzEnabled ? scanStatus?.musicbrainz?.batch : undefined;
  const spotifyCooldown = Boolean(spotifyOperational?.cooldownActive);
  const scanHistory = scanStatus?.history ?? [];
  const selectedHistoryRun =
    scanHistory.find((run) => run.id === selectedHistoryId) ??
    scanHistory.find((run) => run.id === scanStatus?.defaultHistoryId) ??
    scanHistory[0] ??
    null;
  useEffect(() => {
    setSelectedHistoryId((current) =>
      current && scanHistory.some((run) => run.id === current)
        ? current
        : (scanStatus?.defaultHistoryId ?? scanHistory[0]?.id ?? null),
    );
  }, [scanHistory, scanStatus?.defaultHistoryId]);
  const spotifyRemaining = spotifyBatch
    ? Math.max(
        0,
        spotifyBatch.totalArtists -
          spotifyBatch.completedArtists -
          spotifyBatch.partialArtists -
          spotifyBatch.failedArtists -
          spotifyBatch.cancelledArtists -
          spotifyBatch.rateLimitedArtists -
          spotifyBatch.blockedMappingArtists,
      )
    : 0;
  const retryableArtist = spotifyBatch?.artistScans.find((artist) =>
    ["failed", "rate_limited", "cancelled", "blocked_mapping"].includes(artist.status),
  );
  const showSpotifyOperationalPanel = Boolean(
    spotifyBatch &&
    (scanStatus?.running ||
      ["pending", "running", "paused", "rate_limited", "blocked_mapping"].includes(
        spotifyBatch.status,
      ) ||
      retryableArtist),
  );
  const estimatedRemainingRequests = spotifyBatch
    ? Math.ceil(
        (spotifyBatch.estimatedRequests / Math.max(spotifyBatch.totalArtists, 1)) *
          spotifyRemaining,
      )
    : 0;
  const estimatedMinimumMs =
    estimatedRemainingRequests * (scanStatus?.spotify.limiter.minRequestIntervalMs ?? 10_000);
  const estimatedMaximumMs = Math.ceil(estimatedMinimumMs * 1.5);
  const observedRequestRate =
    activeScan?.heartbeatAt && activeScan.requests > 0
      ? activeScan.requests /
        Math.max(
          (new Date(activeScan.heartbeatAt).getTime() - new Date(activeScan.startedAt).getTime()) /
            60_000,
          1 / 60,
        )
      : 0;
  const finishedProviderCount = activeScan
    ? new Set([...activeScan.providersCompleted, ...activeScan.providersFailed]).size
    : 0;
  const providerCount = activeScan?.providersRequested.length ?? 0;
  const currentProviderProgress = activeScan?.totalUnits
    ? Math.min(activeScan.completedUnits / activeScan.totalUnits, 1)
    : 0;
  const completedPercentage = providerCount
    ? Math.round(((finishedProviderCount + currentProviderProgress) / providerCount) * 100)
    : 0;
  const scanProgressText =
    activeScan?.cancelRequested || cancellingScan
      ? "Cancellation requested"
      : activeScan?.phase === "rate_limit_wait" && activeScan.currentProvider
        ? `${titleCase(activeScan.currentProvider)} rate limit wait | retrying in ${Math.ceil(
            activeScan.retryAfterMs / 1_000,
          )} seconds`
        : activeScan?.totalUnits && activeScan.currentProvider
          ? `${activeScan.completedUnits} of ${activeScan.totalUnits} artists finished | scanning ${titleCase(
              activeScan.currentProvider,
            )}${activeScan.requests ? ` | ${activeScan.requests} requests` : ""}`
          : activeScan
            ? `${finishedProviderCount} of ${providerCount} providers finished${
                activeScan.currentProvider
                  ? ` | scanning ${titleCase(activeScan.currentProvider)}`
                  : ""
              }`
            : "Starting provider scan";

  return (
    <section className="content">
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            <span className="live-dot" />{" "}
            {viewMode === "history"
              ? "OPERATIONS"
              : feedMode === "database"
                ? "DATABASE FEED"
                : feedMode === "error"
                  ? "DATABASE UNAVAILABLE"
                  : "MOCK SCAN HEALTHY"}
          </p>
          <h1>{viewMode === "history" ? "History and Schedules" : "Discovery feed"}</h1>
        </div>
        {viewMode === "feed" && feedMode === "database" && (
          <div className="feed-refresh-control">
            {feedRefreshMessage && (
              <span
                className={feedRefreshState === "error" ? "feed-refresh-error" : ""}
                role={feedRefreshState === "error" ? "alert" : "status"}
              >
                {feedRefreshMessage}
              </span>
            )}
            <button
              aria-label="Refresh feed"
              className="secondary-button"
              disabled={feedRefreshState === "checking"}
              onClick={onRefreshFeed}
              type="button"
            >
              <RefreshCw
                aria-hidden="true"
                className={feedRefreshState === "checking" ? "spinning" : ""}
                size={15}
              />
              {feedRefreshState === "checking" ? "Checking" : "Refresh feed"}
            </button>
          </div>
        )}
      </div>

      {viewMode === "feed" && (
        <div className="metrics" aria-label="Feed summary">
          <div>
            <span>New this week</span>
            <strong>{feedSummary.newThisWeek}</strong>
            <small>+{lastScanInsertedCount} since last scan</small>
          </div>
          <div>
            <span>Upcoming</span>
            <strong>{feedSummary.upcoming}</strong>
            <small>Next 30 days</small>
          </div>
          <div>
            <span>Needs review</span>
            <strong className="attention">{reviewCount}</strong>
            <small>Blocked from export</small>
          </div>
          <div className="last-scan-metric">
            <div className="metric-heading">
              <span>Last scan</span>
              <button
                aria-label={feedMode === "mock" ? "Run mock scan" : "Run release update now"}
                className="metric-scan-button"
                disabled={
                  syncing ||
                  scanStatus?.running ||
                  (spotifyCooldown && !musicbrainzConfigured) ||
                  !ready ||
                  feedMode === "error"
                }
                onClick={onRunScan}
                title={
                  feedMode === "mock"
                    ? "Run mock scan"
                    : spotifyCooldown
                      ? musicbrainzEnabled && musicbrainzConfigured
                        ? "Run MusicBrainz-only update while Spotify is cooling down"
                        : "Provider scan disabled during Spotify cooldown"
                      : scanStatus?.running
                        ? "Release update in progress"
                        : "Run release update now"
                }
                type="button"
              >
                <RefreshCw
                  aria-hidden="true"
                  className={syncing || scanStatus?.running ? "spinning" : ""}
                  size={16}
                />
              </button>
            </div>
            <strong className="time-value">
              {feedMode === "mock"
                ? "09:10"
                : scanStatus?.latest
                  ? formatScanTime(scanStatus.latest.completedAt ?? scanStatus.latest.startedAt)
                  : scanStatus
                    ? "Never"
                    : "Loading"}
            </strong>
            <small>
              {feedMode === "mock"
                ? "Mock provider | 4 sources"
                : scanStatus?.running
                  ? "Provider update in progress"
                  : scanStatus?.latest
                    ? scanRunLabel(scanStatus.latest)
                    : "No provider scan recorded"}
            </small>
          </div>
        </div>
      )}

      {scanInProgress && (
        <div className="scan-progress" role="status">
          <div className="scan-progress-heading">
            <div>
              <strong>Release update in progress</strong>
              <span>{scanProgressText}</span>
              {activeScan?.currentStage && (
                <small>
                  Stage: {titleCase(activeScan.currentStage)}
                  {activeScan.lastPersistedResult
                    ? ` | Last persisted: ${activeScan.lastPersistedResult}`
                    : ""}
                </small>
              )}
            </div>
            <div className="scan-progress-actions">
              {providerCount > 0 && (
                <span className="scan-progress-count">
                  {finishedProviderCount}/{providerCount}
                </span>
              )}
              {feedMode === "database" && (
                <button
                  className="scan-cancel-button"
                  disabled={cancellingScan || activeScan?.cancelRequested}
                  onClick={onCancelScan}
                  type="button"
                >
                  Cancel update
                </button>
              )}
            </div>
          </div>
          <div
            aria-label="Release update progress"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={completedPercentage}
            aria-valuetext={scanProgressText}
            className="scan-progress-track"
            role="progressbar"
          >
            <span className="scan-progress-complete" style={{ width: `${completedPercentage}%` }} />
            <span className="scan-progress-active" style={{ left: `${completedPercentage}%` }} />
          </div>
        </div>
      )}

      {viewMode === "history" && feedMode === "database" && !scanInProgress && (
        <ScanHistoryPanel
          hasMore={scanStatus?.historyHasMore ?? false}
          history={scanHistory}
          loadingOlder={loadingOlderHistory}
          onLoadOlder={onLoadOlderHistory}
          onSelect={setSelectedHistoryId}
          onStartReconciliation={() => {
            if (
              window.confirm(
                "Start a deep reconciliation batch? It may inspect up to 10 album pages per artist and will use the ten-second global request interval.",
              )
            ) {
              onSpotifyBatchAction("start_reconciliation", "");
            }
          }}
          selectedRun={selectedHistoryRun}
          state={scanStatusState}
          spotifyCooldown={spotifyCooldown}
        />
      )}

      {viewMode === "history" && feedMode === "database" && discoverySchedule && (
        <section
          className={`spotify-scan-status ${appleSchedulerCollapsed ? "is-collapsed" : ""}`}
          aria-label="Apple Music discovery schedule status"
        >
          <div className="spotify-scan-status-heading">
            <div className="spotify-scan-status-summary">
              <button
                aria-expanded={!appleSchedulerCollapsed}
                aria-label={`${appleSchedulerCollapsed ? "Expand" : "Collapse"} Apple Music discovery schedule status`}
                className="feed-item-disclosure"
                onClick={() => setAppleSchedulerCollapsed((current) => !current)}
                title={`${appleSchedulerCollapsed ? "Expand" : "Collapse"} Apple Music discovery schedule status`}
                type="button"
              >
                {appleSchedulerCollapsed ? <ChevronRight size={17} /> : <ChevronDown size={17} />}
              </button>
              <div>
                <strong>Apple Music discovery schedule</strong>
                <span>{titleCase(discoverySchedule.phase)}</span>
              </div>
            </div>
          </div>
          {!appleSchedulerCollapsed && (
            <>
              <dl className="spotify-scan-grid scheduler-status-grid">
                <div>
                  <dt>Thursday full scan</dt>
                  <dd>
                    {discoverySchedule.full.latest
                      ? `${titleCase(discoverySchedule.full.latest.status)}${
                          discoverySchedule.full.latest.batchTotalArtists !== null
                            ? ` | ${discoverySchedule.full.latest.batchCompletedArtists ?? 0}/${discoverySchedule.full.latest.batchTotalArtists}`
                            : ""
                        }`
                      : "Not recorded"}
                  </dd>
                </div>
                <div>
                  <dt>Next Thursday full scan</dt>
                  <dd>
                    {discoverySchedule.full.next
                      ? new Date(discoverySchedule.full.next.scheduledFor).toLocaleString()
                      : "Unavailable"}
                  </dd>
                </div>
                <div>
                  <dt>Friday catch-up</dt>
                  <dd>
                    {discoverySchedule.catchup.latest
                      ? `${titleCase(discoverySchedule.catchup.latest.status)}${
                          discoverySchedule.catchup.latest.batchTotalArtists !== null
                            ? ` | ${discoverySchedule.catchup.latest.batchCompletedArtists ?? 0}/${discoverySchedule.catchup.latest.batchTotalArtists}`
                            : ""
                        }`
                      : "Not recorded"}
                  </dd>
                </div>
                <div>
                  <dt>Next Friday catch-up</dt>
                  <dd>
                    {discoverySchedule.catchup.next
                      ? new Date(discoverySchedule.catchup.next.scheduledFor).toLocaleString()
                      : "Unavailable"}
                  </dd>
                </div>
                <div>
                  <dt>Automatic playlist inbox</dt>
                  <dd>
                    {discoveryPlaylistStatusLabel(discoverySchedule, spotifyCooldown)} | Pending
                    operations {discoverySchedule.playlistInbox.pendingCount}
                  </dd>
                </div>
              </dl>
              <small>
                Full scan: Thursday 9:00 PM. Catch-up: Friday 9:00 AM. Times use America/Los_Angeles
                and missed jobs expire after a bounded 24-hour recovery window.
              </small>
            </>
          )}
        </section>
      )}

      {viewMode === "history" && feedMode === "database" && spotifyScheduler && (
        <section
          className={`spotify-scan-status ${spotifySchedulerCollapsed ? "is-collapsed" : ""}`}
          aria-label="Spotify rolling scheduler status"
        >
          <div className="spotify-scan-status-heading">
            <div className="spotify-scan-status-summary">
              <button
                aria-expanded={!spotifySchedulerCollapsed}
                aria-label={`${spotifySchedulerCollapsed ? "Expand" : "Collapse"} Spotify rolling scheduler status`}
                className="feed-item-disclosure"
                onClick={() => setSpotifySchedulerCollapsed((current) => !current)}
                title={`${spotifySchedulerCollapsed ? "Expand" : "Collapse"} Spotify rolling scheduler status`}
                type="button"
              >
                {spotifySchedulerCollapsed ? <ChevronRight size={17} /> : <ChevronDown size={17} />}
              </button>
              <div>
                <strong>Spotify rolling scheduler</strong>
                <span>{titleCase(spotifyScheduler.mode)}</span>
              </div>
            </div>
          </div>
          {!spotifySchedulerCollapsed && (
            <>
              <dl className="spotify-scan-grid scheduler-status-grid">
                <div>
                  <dt>Current work</dt>
                  <dd>
                    {spotifyScheduler.activeLease
                      ? `${titleCase(spotifyScheduler.activeLease.workType)} | ${spotifyScheduler.activeLease.artistId ?? "release work"}`
                      : "Idle"}
                  </dd>
                </div>
                <div>
                  <dt>Recently completed</dt>
                  <dd>
                    {spotifyScheduler.recentWork
                      ? `${titleCase(spotifyScheduler.recentWork.workType)} | ${new Date(spotifyScheduler.recentWork.completedAt).toLocaleString()}`
                      : "None"}
                  </dd>
                </div>
                <div>
                  <dt>Lease expires</dt>
                  <dd>
                    {spotifyScheduler.activeLease
                      ? new Date(spotifyScheduler.activeLease.expiresAt).toLocaleString()
                      : "None"}
                  </dd>
                </div>
                <div>
                  <dt>Eligible artists</dt>
                  <dd>{spotifyScheduler.eligibleArtistCount}</dd>
                </div>
                <div>
                  <dt>Due / overdue</dt>
                  <dd>
                    {spotifyScheduler.dueArtistCount} / {spotifyScheduler.overdueArtistCount}
                  </dd>
                </div>
                <div>
                  <dt>Oldest overdue</dt>
                  <dd>
                    {spotifyScheduler.oldestOverdueAgeMs === null
                      ? "None"
                      : formatDuration(spotifyScheduler.oldestOverdueAgeMs)}
                  </dd>
                </div>
                <div>
                  <dt>Checked in 24 hours</dt>
                  <dd>{spotifyScheduler.artistsCheckedLast24Hours}</dd>
                </div>
                <div>
                  <dt>Broad backlog / coverage</dt>
                  <dd>
                    {spotifyScheduler.backlog.base_artist} / {spotifyScheduler.eligibleArtistCount}
                  </dd>
                </div>
                <div>
                  <dt>Apple full-scan priority</dt>
                  <dd>{spotifyScheduler.applePriorityCount}</dd>
                </div>
                <div>
                  <dt>Friday catch-up priority</dt>
                  <dd>{spotifyScheduler.appleCatchupPriorityCount}</dd>
                </div>
                <div>
                  <dt>Broad artists today</dt>
                  <dd>
                    {spotifyScheduler.dailyBudget.broadArtistsUsed} /{" "}
                    {spotifyScheduler.dailyBudget.broadArtistsLimit}
                  </dd>
                </div>
                <div>
                  <dt>Broad request budget</dt>
                  <dd>
                    {spotifyScheduler.dailyBudget.broadRequestsUsed} /{" "}
                    {spotifyScheduler.dailyBudget.broadRequestsLimit}
                  </dd>
                </div>
                <div>
                  <dt>Reserved requests</dt>
                  <dd>
                    Priority {spotifyScheduler.dailyBudget.priorityRequestReserve} | Playlist{" "}
                    {spotifyScheduler.dailyBudget.playlistRequestReserve}
                  </dd>
                </div>
                <div>
                  <dt>Artist Albums budget</dt>
                  <dd>
                    {spotifyScheduler.endpointBudget.artistAlbums.calls} /{" "}
                    {spotifyScheduler.endpointBudget.artistAlbums.allowance} | Broad{" "}
                    {spotifyScheduler.endpointBudget.artistAlbums.broadUsed} /{" "}
                    {spotifyScheduler.endpointBudget.artistAlbums.broadAllowance}
                  </dd>
                </div>
                <div>
                  <dt>Artist Albums reserve</dt>
                  <dd>
                    {spotifyScheduler.endpointBudget.artistAlbums.reserveRemaining} /{" "}
                    {spotifyScheduler.endpointBudget.artistAlbums.priorityReserve} remaining |{" "}
                    {spotifyScheduler.endpointBudget.artistAlbums.reserveReleased
                      ? "Released cautiously"
                      : "Held for priority"}
                  </dd>
                </div>
                <div>
                  <dt>Playlist requests, 24h</dt>
                  <dd>
                    {spotifyScheduler.endpointBudget.playlist.reads} reads /{" "}
                    {spotifyScheduler.endpointBudget.playlist.writes} writes
                  </dd>
                </div>
                <div>
                  <dt>Release detail / tracks</dt>
                  <dd>
                    {spotifyScheduler.backlog.release_detail} /{" "}
                    {spotifyScheduler.backlog.release_tracks}
                  </dd>
                </div>
                <div>
                  <dt>Reconciliation backlog</dt>
                  <dd>{spotifyScheduler.backlog.artist_reconciliation}</dd>
                </div>
                <div>
                  <dt>Blocked / partial</dt>
                  <dd>
                    {spotifyScheduler.blockedCount} / {spotifyScheduler.partialArtistCount}
                    {spotifyScheduler.blockedReasons.length > 0
                      ? ` | ${spotifyScheduler.blockedReasons.join(", ")}`
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt>Requests, 30m / 24h</dt>
                  <dd>
                    {spotifyScheduler.requestCounts.last30Minutes} /{" "}
                    {spotifyScheduler.requestCounts.last24Hours}
                  </dd>
                </div>
                <div>
                  <dt>Requests by work</dt>
                  <dd>
                    B {spotifyScheduler.requestCounts.byWorkType.base_artist ?? 0} | D{" "}
                    {spotifyScheduler.requestCounts.byWorkType.release_detail ?? 0} | T{" "}
                    {spotifyScheduler.requestCounts.byWorkType.release_tracks ?? 0} | R{" "}
                    {spotifyScheduler.requestCounts.byWorkType.artist_reconciliation ?? 0}
                  </dd>
                </div>
                <div>
                  <dt>HTTP 429, 24h</dt>
                  <dd>{spotifyScheduler.http429Last24Hours}</dd>
                </div>
                <div>
                  <dt>Last quota exceeded</dt>
                  <dd>
                    {spotifyScheduler.lastQuotaExceeded
                      ? `${titleCase(spotifyScheduler.lastQuotaExceeded.endpointCategory)} | ${new Date(spotifyScheduler.lastQuotaExceeded.observedAt).toLocaleString()}${spotifyScheduler.lastQuotaExceeded.cooldownUntil ? ` | Cooldown until ${new Date(spotifyScheduler.lastQuotaExceeded.cooldownUntil).toLocaleString()}` : ""}`
                      : "None recorded in 24 hours"}
                  </dd>
                </div>
                <div>
                  <dt>Cooldown</dt>
                  <dd>
                    {spotifyScheduler.cooldownActive
                      ? spotifyScheduler.cooldownUntil
                        ? `Until ${new Date(spotifyScheduler.cooldownUntil).toLocaleString()}`
                        : "Blocked pending manual review"
                      : "None"}
                  </dd>
                </div>
                <div>
                  <dt>Estimated completion</dt>
                  <dd>
                    {spotifyScheduler.estimatedCompletion.state === "blocked"
                      ? "Blocked"
                      : spotifyScheduler.estimatedCompletion.earliest &&
                          spotifyScheduler.estimatedCompletion.latest
                        ? `${new Date(spotifyScheduler.estimatedCompletion.earliest).toLocaleString()} to ${new Date(spotifyScheduler.estimatedCompletion.latest).toLocaleString()}`
                        : "Unavailable"}
                  </dd>
                </div>
              </dl>
              <small>
                Automatic execution is disabled by default. This panel reads persisted scheduler
                state and never starts provider work.
              </small>
            </>
          )}
        </section>
      )}

      {viewMode === "history" &&
        feedMode === "database" &&
        musicbrainzEnabled &&
        musicbrainzBatch &&
        (scanStatus?.running ||
          (["paused", "cancelled", "failed"].includes(musicbrainzBatch.status) &&
            musicbrainzBatch.completedArtists < musicbrainzBatch.totalArtists)) && (
          <section className="spotify-scan-status" aria-label="MusicBrainz scan status">
            <div className="spotify-scan-status-heading">
              <div>
                <strong>MusicBrainz discovery</strong>
                <span>
                  {musicbrainzBatch.completedArtists} of {musicbrainzBatch.totalArtists} artists |{" "}
                  {titleCase(musicbrainzBatch.status)}
                </span>
              </div>
              {["paused", "cancelled", "failed"].includes(musicbrainzBatch.status) &&
                musicbrainzBatch.completedArtists < musicbrainzBatch.totalArtists && (
                  <button
                    className="primary-button"
                    disabled={Boolean(scanStatus?.running)}
                    onClick={() => onMusicBrainzResume(musicbrainzBatch.id)}
                    type="button"
                  >
                    Resume MusicBrainz
                  </button>
                )}
            </div>
          </section>
        )}

      {viewMode === "history" &&
        feedMode === "database" &&
        showSpotifyOperationalPanel &&
        spotifyBatch && (
          <section
            className={`spotify-scan-status ${spotifyStatusCollapsed ? "is-collapsed" : ""}`}
            aria-label="Spotify scan status"
          >
            <div className="spotify-scan-status-heading">
              <div className="spotify-scan-status-summary">
                <button
                  aria-expanded={!spotifyStatusCollapsed}
                  aria-label={`${spotifyStatusCollapsed ? "Expand" : "Collapse"} Spotify scan status`}
                  className="feed-item-disclosure"
                  onClick={() => setSpotifyStatusCollapsed((current) => !current)}
                  title={`${spotifyStatusCollapsed ? "Expand" : "Collapse"} Spotify scan status`}
                  type="button"
                >
                  {spotifyStatusCollapsed ? <ChevronRight size={17} /> : <ChevronDown size={17} />}
                </button>
                <div>
                  <strong>Spotify {titleCase(spotifyBatch.mode)} scan</strong>
                  <span>
                    {spotifyBatch.status === "paused" && spotifyBatch.confirmationRequired
                      ? "Awaiting confirmation before the first staged batch"
                      : titleCase(spotifyBatch.status)}
                  </span>
                </div>
              </div>
              {!spotifyStatusCollapsed && (
                <div className="scan-progress-actions">
                  {spotifyBatch.status === "running" && (
                    <button
                      className="secondary-button"
                      onClick={() => onSpotifyBatchAction("pause", spotifyBatch.id)}
                      type="button"
                    >
                      Pause after current request
                    </button>
                  )}
                  {["paused", "rate_limited", "pending"].includes(spotifyBatch.status) && (
                    <button
                      className="primary-button"
                      disabled={spotifyCooldown || scanStatus?.running}
                      onClick={() => onSpotifyBatchAction("resume", spotifyBatch.id)}
                      type="button"
                    >
                      Resume
                    </button>
                  )}
                  {["pending", "running", "paused", "rate_limited"].includes(
                    spotifyBatch.status,
                  ) && (
                    <button
                      className="secondary-button destructive-text"
                      onClick={() => onSpotifyBatchAction("cancel", spotifyBatch.id)}
                      type="button"
                    >
                      Cancel future work
                    </button>
                  )}
                  {retryableArtist && (
                    <button
                      className="secondary-button"
                      disabled={spotifyCooldown || scanStatus?.running}
                      onClick={() => onSpotifyBatchAction("retry_artist", retryableArtist.id)}
                      type="button"
                    >
                      Retry one artist
                    </button>
                  )}
                  {["completed", "failed", "cancelled"].includes(spotifyBatch.status) && (
                    <button
                      className="secondary-button"
                      disabled={spotifyCooldown || scanStatus?.running}
                      onClick={() => {
                        if (
                          window.confirm(
                            "Start a deep reconciliation batch? It may inspect up to 10 album pages per artist and will use the ten-second global request interval.",
                          )
                        ) {
                          onSpotifyBatchAction("start_reconciliation", "");
                        }
                      }}
                      type="button"
                    >
                      Deep reconciliation
                    </button>
                  )}
                </div>
              )}
            </div>
            {!spotifyStatusCollapsed && (
              <>
                <dl className="spotify-scan-grid">
                  <div>
                    <dt>Current artist</dt>
                    <dd>{activeScan?.currentUnit ?? "None"}</dd>
                  </div>
                  <div>
                    <dt>Completed</dt>
                    <dd>{spotifyBatch.completedArtists}</dd>
                  </div>
                  <div>
                    <dt>Remaining</dt>
                    <dd>{spotifyRemaining}</dd>
                  </div>
                  <div>
                    <dt>Failed</dt>
                    <dd>{spotifyBatch.failedArtists}</dd>
                  </div>
                  <div>
                    <dt>Cancelled</dt>
                    <dd>{spotifyBatch.cancelledArtists}</dd>
                  </div>
                  <div>
                    <dt>Rate-limited</dt>
                    <dd>{spotifyBatch.rateLimitedArtists}</dd>
                  </div>
                  <div>
                    <dt>Blocked mapping</dt>
                    <dd>{spotifyBatch.blockedMappingArtists}</dd>
                  </div>
                  <div>
                    <dt>Partial</dt>
                    <dd>{spotifyBatch.partialArtists}</dd>
                  </div>
                  <div>
                    <dt>Queue</dt>
                    <dd>{spotifyOperational?.queueDepth ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Request interval</dt>
                    <dd>{(scanStatus.spotify.limiter.minRequestIntervalMs / 1_000).toFixed(1)}s</dd>
                  </div>
                  <div>
                    <dt>Estimated requests</dt>
                    <dd>{spotifyBatch.estimatedRequests}</dd>
                  </div>
                  <div>
                    <dt>Estimated remaining</dt>
                    <dd>
                      {estimatedRemainingRequests > 0
                        ? `${formatDuration(estimatedMinimumMs)} to ${formatDuration(estimatedMaximumMs)}`
                        : "Complete"}
                    </dd>
                  </div>
                  <div>
                    <dt>Current request rate</dt>
                    <dd>
                      {observedRequestRate > 0 ? `${observedRequestRate.toFixed(1)}/min` : "Idle"}
                    </dd>
                  </div>
                  <div>
                    <dt>Last heartbeat</dt>
                    <dd>
                      {activeScan?.heartbeatAt
                        ? new Date(activeScan.heartbeatAt).toLocaleTimeString()
                        : "Idle"}
                    </dd>
                  </div>
                  <div>
                    <dt>Cooldown</dt>
                    <dd>
                      {spotifyCooldown
                        ? spotifyOperational?.cooldownIndefinite
                          ? "Manual review required"
                          : `Until ${new Date(spotifyOperational!.cooldownUntil!).toLocaleString()}`
                        : "None"}
                    </dd>
                  </div>
                  <div>
                    <dt>Fully reconciled artists</dt>
                    <dd>{scanStatus.spotify.coverage.fullyReconciledArtists}</dd>
                  </div>
                  <div>
                    <dt>Partial catalogs</dt>
                    <dd>{scanStatus.spotify.coverage.partialArtists}</dd>
                  </div>
                  <div>
                    <dt>Awaiting reconciliation</dt>
                    <dd>{scanStatus.spotify.coverage.queuedArtists}</dd>
                  </div>
                  <div>
                    <dt>Estimated remaining pages</dt>
                    <dd>{scanStatus.spotify.coverage.estimatedRemainingPages}</dd>
                  </div>
                  <div>
                    <dt>Reconciliation cycle progress</dt>
                    <dd>{scanStatus.spotify.coverage.currentCycleCompletedPages} pages</dd>
                  </div>
                </dl>
                <small>
                  Distributed across {scanStatus.spotify.limiter.distributionHours} hours, about{" "}
                  {(
                    spotifyBatch.totalArtists / scanStatus.spotify.limiter.distributionHours
                  ).toFixed(1)}{" "}
                  artists per hour. Completion estimates vary with pagination and Spotify limits.
                </small>
              </>
            )}
          </section>
        )}

      {viewMode === "history" && feedMode !== "database" && (
        <div className={feedMode === "error" ? "error-state" : "empty-state"} role="status">
          <Clock3 size={22} />
          <strong>History and schedules are unavailable.</strong>
          <span>This view requires the persisted database connection.</span>
        </div>
      )}

      {viewMode === "feed" && (
        <>
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
                Evidence source
                <select
                  aria-label="Evidence source"
                  value={advancedFilters.provider}
                  onChange={(event) =>
                    onAdvancedFiltersChange({
                      ...advancedFilters,
                      provider: event.target.value as FeedAdvancedFilters["provider"],
                    })
                  }
                >
                  <option value="all">All</option>
                  <option value="musicbrainz">MusicBrainz</option>
                  <option value="apple_music">Apple Music</option>
                  <option value="spotify">Spotify</option>
                  <option value="mock">Mock</option>
                </select>
              </label>
              <label>
                Spotify
                <select
                  aria-label="Spotify availability"
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
                <strong>The persisted discovery feed is temporarily unavailable.</strong>
                <span>
                  Mock records are not shown here. Existing discoveries remain stored in PostgreSQL.
                </span>
                <button className="secondary-button" onClick={onRetryDatabase} type="button">
                  Retry database connection
                </button>
              </div>
            )}
            {items.length ? (
              groupFeedItems(items, activeFilter === "new").map((group) => {
                if (group.items.length === 1) {
                  return (
                    <FeedItem
                      item={group.items[0]!}
                      key={group.key}
                      onItemChange={onItemChange}
                      onTogglePreference={onTogglePreference}
                      pendingFeedActions={pendingFeedActions}
                      onSoundCloudLinkChange={onSoundCloudLinkChange}
                      soundCloudManualLinksEnabled={soundCloudManualLinksEnabled}
                      soundCloudLink={soundCloudLinks[group.items[0]!.id]}
                    />
                  );
                }

                const collapsed = collapsedReleaseGroups.includes(group.key);
                const groupTitle = `${group.artist} - ${group.releaseTitle}`;
                return (
                  <section
                    aria-label={`${groupTitle} ${titleCase(group.releaseType)}`}
                    className={`release-feed-group ${collapsed ? "is-collapsed" : ""}`}
                    data-feed-anchor={group.key}
                    key={group.key}
                  >
                    <div className="release-feed-group-heading">
                      <button
                        aria-expanded={!collapsed}
                        aria-label={`${collapsed ? "Expand" : "Collapse"} ${groupTitle} ${titleCase(group.releaseType)}`}
                        className="release-group-disclosure"
                        onClick={() =>
                          setCollapsedReleaseGroups((current) =>
                            current.includes(group.key)
                              ? current.filter((key) => key !== group.key)
                              : [...current, group.key],
                          )
                        }
                        title={`${collapsed ? "Expand" : "Collapse"} release`}
                        type="button"
                      >
                        {collapsed ? <ChevronRight size={17} /> : <ChevronDown size={17} />}
                      </button>
                      <FeedArtwork
                        compact
                        item={
                          group.items.find(
                            (item) => item.spotifyArtwork || item.appleMusicArtwork,
                          ) ?? group.items[0]!
                        }
                      />
                      <div className="release-feed-group-title">
                        <span>{titleCase(group.releaseType)}</span>
                        <strong>{groupTitle}</strong>
                        <small>{formatReleaseGroupDate(group.releaseDate)}</small>
                      </div>
                      <span className="release-feed-group-count">{group.items.length} tracks</span>
                    </div>
                    {!collapsed && (
                      <div className="release-feed-group-items">
                        {group.items.map((item) => (
                          <FeedItem
                            item={item}
                            key={item.id}
                            onItemChange={onItemChange}
                            onTogglePreference={onTogglePreference}
                            pendingFeedActions={pendingFeedActions}
                            onSoundCloudLinkChange={onSoundCloudLinkChange}
                            soundCloudManualLinksEnabled={soundCloudManualLinksEnabled}
                            soundCloudLink={soundCloudLinks[item.id]}
                          />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })
            ) : feedMode !== "error" ? (
              <div className="empty-state">
                <Search size={22} />
                <strong>No discoveries match this view.</strong>
                <span>Clear the search or choose another state.</span>
              </div>
            ) : null}
          </div>
          {viewMode === "feed" && feedMode === "database" && feedPageState === "error" && (
            <div className="form-error feed-page-state" role="alert">
              More discoveries could not be loaded. The items already shown remain available.
            </div>
          )}
          {viewMode === "feed" && feedMode === "database" && feedHasMore && (
            <div className="feed-pagination-actions">
              <button
                className="secondary-button"
                disabled={feedPageState === "loading"}
                onClick={onLoadMore}
                type="button"
              >
                {feedPageState === "loading" ? "Loading discoveries" : "Load more discoveries"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ScanHistoryPanel({
  hasMore,
  history,
  loadingOlder,
  onLoadOlder,
  onSelect,
  onStartReconciliation,
  selectedRun,
  spotifyCooldown,
  state,
}: {
  hasMore: boolean;
  history: ScanHistoryEntry[];
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onSelect: (id: string) => void;
  onStartReconciliation: () => void;
  selectedRun: ScanHistoryEntry | null;
  spotifyCooldown: boolean;
  state: "idle" | "loading" | "loaded" | "error";
}) {
  return (
    <section className="spotify-scan-status scan-history-panel" aria-label="Scan history status">
      <div className="spotify-scan-status-heading">
        <div>
          <strong>Scan history</strong>
          <span>
            {selectedRun ? scanHistoryRunLabel(selectedRun) : "Previously persisted scan results"}
          </span>
        </div>
        {history.length > 0 && selectedRun && (
          <div className="scan-history-actions">
            <label>
              <span>Inspect scan</span>
              <select
                aria-label="Inspect scan history"
                onChange={(event) => onSelect(event.target.value)}
                value={selectedRun.id}
              >
                {history.map((run) => (
                  <option key={run.id} value={run.id}>
                    {scanHistoryOptionLabel(run)}
                  </option>
                ))}
              </select>
            </label>
            {selectedRun.provider === "spotify" &&
              ["completed", "failed", "cancelled"].includes(selectedRun.status) && (
                <button
                  className="secondary-button"
                  disabled={spotifyCooldown}
                  onClick={onStartReconciliation}
                  type="button"
                >
                  Deep reconciliation
                </button>
              )}
          </div>
        )}
      </div>

      {(state === "idle" || state === "loading") && (
        <div className="scan-history-state" role="status">
          Loading scan history...
        </div>
      )}
      {state === "error" && (
        <div className="scan-history-state form-error" role="alert">
          Scan history is temporarily unavailable. The application will retry automatically.
        </div>
      )}
      {state === "loaded" && history.length === 0 && (
        <div className="scan-history-state empty-inline">No scan history is recorded.</div>
      )}
      {state === "loaded" && selectedRun && (
        <>
          <dl className="spotify-scan-grid scan-history-grid">
            <div>
              <dt>Scan ID</dt>
              <dd className="monospace-value">{selectedRun.id}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{titleCase(selectedRun.status)}</dd>
            </div>
            <div>
              <dt>Trigger</dt>
              <dd>{titleCase(selectedRun.triggerType)}</dd>
            </div>
            <div>
              <dt>Provider</dt>
              <dd>{scanHistoryProviderLabel(selectedRun)}</dd>
            </div>
            <div>
              <dt>Artists</dt>
              <dd>{formatKnownCount(selectedRun.artistCount)}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{new Date(selectedRun.startedAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Finished</dt>
              <dd>
                {selectedRun.completedAt
                  ? new Date(selectedRun.completedAt).toLocaleString()
                  : "Unavailable"}
              </dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{formatScanHistoryDuration(selectedRun)}</dd>
            </div>
            <div>
              <dt>Requests</dt>
              <dd>{formatKnownCount(selectedRun.requestCount)}</dd>
            </div>
            <div>
              <dt>Created records</dt>
              <dd>{selectedRun.createdCount}</dd>
            </div>
            <div>
              <dt>Updated records</dt>
              <dd>{selectedRun.updatedCount}</dd>
            </div>
            <div>
              <dt>Partial artists</dt>
              <dd>{formatKnownCount(selectedRun.partialArtistCount)}</dd>
            </div>
            <div>
              <dt>Failures</dt>
              <dd>{formatKnownCount(selectedRun.failureCount)}</dd>
            </div>
            <div>
              <dt>Review items</dt>
              <dd>{selectedRun.reviewCount}</dd>
            </div>
            <div>
              <dt>Dry run</dt>
              <dd>{selectedRun.dryRun ? "Yes" : "No"}</dd>
            </div>
          </dl>
          <small>
            Historical values come from persisted scan and batch records. Unavailable values were
            not stored by that scan.
          </small>
        </>
      )}
      {state === "loaded" && hasMore && (
        <button
          className="secondary-button scan-history-load-more"
          disabled={loadingOlder}
          onClick={onLoadOlder}
          type="button"
        >
          {loadingOlder ? "Loading history" : "Load older scans"}
        </button>
      )}
    </section>
  );
}

function ArtistsView({
  artistProfiles,
  artists,
  onAddArtist,
  onEditArtist,
  onNotice,
  onRefreshArtists,
  onRemoveArtist,
  onRemoveProfile,
  onSaveProfile,
  onScanArtist,
  musicbrainzConfigured,
  musicbrainzEnabled,
  soundCloudManualLinksEnabled,
  watchlistMode,
}: {
  artistProfiles: Record<string, string>;
  artists: WatchedArtist[];
  onAddArtist: (name: string) => boolean;
  onEditArtist: (id: string, name: string) => boolean;
  onNotice: (message: string) => void;
  onRefreshArtists: () => Promise<void>;
  onRemoveArtist: (id: string, name: string) => void;
  onRemoveProfile: (id: string) => void;
  onSaveProfile: (id: string, url: string) => void;
  onScanArtist: (id: string) => void;
  musicbrainzConfigured: boolean;
  musicbrainzEnabled: boolean;
  soundCloudManualLinksEnabled: boolean;
  watchlistMode: "database" | "error" | "mock";
}) {
  const [addingArtist, setAddingArtist] = useState(false);
  const [artistName, setArtistName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [artistSearch, setArtistSearch] = useState("");
  const [sortOrder, setSortOrder] = useState<ArtistSort>("name-asc");
  const [editingArtistId, setEditingArtistId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [profileArtistId, setProfileArtistId] = useState<string | null>(null);
  const [profileUrl, setProfileUrl] = useState("");
  const [profileError, setProfileError] = useState<string | null>(null);
  const [mappingArtist, setMappingArtist] = useState<WatchedArtist | null>(null);
  const [mappingBusy, setMappingBusy] = useState(false);
  const [mappingMode, setMappingMode] = useState<"current" | "replace">("current");
  const [confirmedMapping, setConfirmedMapping] = useState<{
    confidence: string | null;
    externalId: string;
    reasons: string[];
    url: string;
  } | null>(null);
  const [mappingResults, setMappingResults] = useState<
    Array<{
      confirmed: boolean;
      confidence: number;
      disambiguation?: string;
      id: string;
      name: string;
      reasons: string[];
      reviewId?: string;
    }>
  >([]);

  const loadMusicBrainzMapping = async (artist: WatchedArtist) => {
    const response = await fetch(`/api/musicbrainz/mappings?artistId=${artist.id}`, {
      cache: "no-store",
    });
    const payload = musicBrainzMappingsResponseSchema.parse(await response.json());
    if (!response.ok) throw new Error("Unable to load MusicBrainz mapping");
    const mapping = payload.mappings[0] ?? null;
    setConfirmedMapping(mapping);
    return { mapping, reviews: payload.reviews };
  };

  const searchMusicBrainzMapping = async (artist: WatchedArtist) => {
    setMappingBusy(true);
    setMappingMode("replace");
    setMappingResults([]);
    try {
      const response = await fetch("/api/musicbrainz/mappings/preview", {
        body: JSON.stringify({ artistId: artist.id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = z
        .object({
          automatic: z.boolean(),
          results: z.array(
            z.object({
              confidence: z.number(),
              disambiguation: z.string().optional(),
              id: z.string().uuid(),
              name: z.string(),
              reasons: z.array(z.string()),
            }),
          ),
        })
        .parse(await response.json());
      if (!response.ok) throw new Error("Mapping preview failed");
      if (payload.automatic) {
        await loadMusicBrainzMapping(artist);
        await onRefreshArtists();
        onNotice(`${artist.name} received a high-confidence MusicBrainz mapping.`);
        setMappingMode("current");
        return;
      }
      const details = await loadMusicBrainzMapping(artist);
      setMappingResults(
        payload.results.map((result) => {
          const reviewId = details.reviews.find(
            (review) => review.proposedExternalId === result.id && review.status === "pending",
          )?.id;
          return {
            confirmed: details.mapping?.externalId === result.id,
            confidence: result.confidence,
            id: result.id,
            name: result.name,
            reasons: result.reasons,
            ...(result.disambiguation ? { disambiguation: result.disambiguation } : {}),
            ...(reviewId ? { reviewId } : {}),
          };
        }),
      );
    } catch {
      onNotice("MusicBrainz mapping preview failed. No mapping was changed.");
      setMappingMode("current");
    } finally {
      setMappingBusy(false);
    }
  };

  const openMusicBrainzMapping = async (artist: WatchedArtist) => {
    setMappingArtist(artist);
    setMappingMode("current");
    setConfirmedMapping(null);
    setMappingResults([]);
    setMappingBusy(true);
    try {
      const { mapping } = await loadMusicBrainzMapping(artist);
      if (!mapping) {
        setMappingBusy(false);
        await searchMusicBrainzMapping(artist);
      }
    } catch {
      onNotice("The persisted MusicBrainz mapping could not be loaded.");
      setMappingArtist(null);
    } finally {
      setMappingBusy(false);
    }
  };

  const decideMusicBrainzMapping = async (reviewId: string, decision: "confirm" | "reject") => {
    setMappingBusy(true);
    try {
      const response = await fetch("/api/musicbrainz/mappings/decision", {
        body: JSON.stringify({ decision, reviewId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error("Mapping decision failed");
      const result = z
        .object({ decision: z.enum(["confirm", "reject"]), idempotent: z.boolean() })
        .passthrough()
        .parse(await response.json());
      if (decision === "confirm" && mappingArtist) {
        await loadMusicBrainzMapping(mappingArtist);
        await onRefreshArtists();
        setMappingMode("current");
        setMappingResults([]);
      } else {
        setMappingResults((current) => current.filter((item) => item.reviewId !== reviewId));
      }
      onNotice(
        decision === "confirm"
          ? result.idempotent
            ? "MusicBrainz mapping was already confirmed."
            : "MusicBrainz mapping confirmed. A previous mapping was replaced if one existed."
          : "MusicBrainz mapping candidate rejected.",
      );
    } catch {
      onNotice("The MusicBrainz mapping decision could not be saved.");
    } finally {
      setMappingBusy(false);
    }
  };

  const sortedArtists = useMemo(() => {
    const query = artistSearch.trim().toLocaleLowerCase("en-US");
    const matchingArtists = query
      ? artists.filter((artist) => artist.name.toLocaleLowerCase("en-US").includes(query))
      : artists;

    return [...matchingArtists].sort((left, right) => {
      if (sortOrder === "recent") {
        return right.addedAt - left.addedAt || left.name.localeCompare(right.name, "en-US");
      }

      const comparison = left.name.localeCompare(right.name, "en-US");
      return sortOrder === "name-asc" ? comparison : -comparison;
    });
  }, [artistSearch, artists, sortOrder]);

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
        <span aria-live="polite" className="artist-count">
          Followed Artist Count: {artists.length}
        </span>
        <label className="artist-search">
          <Search aria-hidden="true" size={15} />
          <input
            aria-label="Search followed artists"
            autoComplete="off"
            onChange={(event) => setArtistSearch(event.target.value)}
            placeholder="Search artists"
            type="search"
            value={artistSearch}
          />
        </label>
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

      {musicbrainzEnabled && mappingArtist && (
        <section className="add-artist-form" aria-label="MusicBrainz mapping candidates">
          <strong>MusicBrainz mapping for {mappingArtist.name}</strong>
          {mappingBusy && (
            <span role="status">
              {mappingMode === "replace" ? "Searching MusicBrainz" : "Loading confirmed mapping"}
            </span>
          )}
          {!mappingBusy && mappingMode === "current" && confirmedMapping && (
            <div className="inline-row-form confirmed-mapping">
              <div>
                <strong>Confirmed mapping</strong>
                <small>{mappingArtist.name}</small>
                <small>
                  MBID: <code>{confirmedMapping.externalId}</code>
                </small>
                {confirmedMapping.confidence && (
                  <small>{Math.round(Number(confirmedMapping.confidence) * 100)}% confidence</small>
                )}
                <small>{confirmedMapping.reasons.join("; ")}</small>
              </div>
              <a
                className="secondary-button"
                href={confirmedMapping.url}
                rel="noopener noreferrer"
                target="_blank"
              >
                View evidence <ExternalLink size={13} />
              </a>
              <button
                className="secondary-button"
                onClick={() => void searchMusicBrainzMapping(mappingArtist)}
                type="button"
              >
                Replace mapping
              </button>
            </div>
          )}
          {!mappingBusy && mappingMode === "current" && !confirmedMapping && (
            <div className="inline-row-form">
              <span>No confirmed MusicBrainz mapping is stored.</span>
              <button
                className="primary-button"
                onClick={() => void searchMusicBrainzMapping(mappingArtist)}
                type="button"
              >
                Search MusicBrainz
              </button>
            </div>
          )}
          {!mappingBusy && mappingMode === "replace" && mappingResults.length === 0 && (
            <span>
              No safe replacement candidate was found. The current mapping was not changed.
            </span>
          )}
          {mappingMode === "replace" &&
            mappingResults.map((result) => (
              <div className="inline-row-form" key={result.id}>
                <div>
                  <strong>{result.name}</strong>
                  {result.confirmed && <span className="provider-tag">Currently confirmed</span>}
                  <small>
                    {Math.round(result.confidence * 100)}% confidence
                    {result.disambiguation ? ` | ${result.disambiguation}` : ""}
                  </small>
                  <small>MBID: {result.id}</small>
                  <small>{result.reasons.join("; ")}</small>
                </div>
                <a
                  className="secondary-button"
                  href={`https://musicbrainz.org/artist/${result.id}`}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  View evidence <ExternalLink size={13} />
                </a>
                <button
                  className="primary-button"
                  disabled={result.confirmed || !result.reviewId || mappingBusy}
                  onClick={() =>
                    result.reviewId && void decideMusicBrainzMapping(result.reviewId, "confirm")
                  }
                  type="button"
                >
                  {result.confirmed
                    ? "Confirmed"
                    : confirmedMapping
                      ? "Confirm replacement"
                      : "Confirm mapping"}
                </button>
                <button
                  className="secondary-button"
                  disabled={result.confirmed || !result.reviewId || mappingBusy}
                  onClick={() =>
                    result.reviewId && void decideMusicBrainzMapping(result.reviewId, "reject")
                  }
                  type="button"
                >
                  Reject
                </button>
              </div>
            ))}
          {mappingMode === "replace" && confirmedMapping && (
            <button
              className="secondary-button"
              onClick={() => {
                setMappingMode("current");
                setMappingResults([]);
              }}
              type="button"
            >
              Cancel replacement
            </button>
          )}
          <button
            className="secondary-button"
            onClick={() => {
              setMappingArtist(null);
              setConfirmedMapping(null);
              setMappingResults([]);
            }}
            type="button"
          >
            Close
          </button>
        </section>
      )}

      <div className="data-list" aria-label="Followed artists">
        {watchlistMode === "error" && (
          <div className="error-state" role="alert">
            The persisted watchlist could not be loaded. No empty-watchlist state is being inferred.
          </div>
        )}
        {watchlistMode !== "error" && artists.length === 0 && (
          <div className="empty-state">
            <Users size={22} />
            <strong>No followed artists yet.</strong>
            <span>Add an artist manually or import followed artists from Spotify.</span>
          </div>
        )}
        {watchlistMode !== "error" && artists.length > 0 && sortedArtists.length === 0 && (
          <div className="empty-state">
            <Search size={22} />
            <strong>No artists match your search.</strong>
            <span>Try another artist name.</span>
          </div>
        )}
        {sortedArtists.map((artist) => (
          <div className="data-row" key={artist.id}>
            <span className="artist-monogram">{artist.name.slice(0, 2).toUpperCase()}</span>
            <div>
              <strong>{artist.name}</strong>
              <small>
                {artist.source === "spotify_import"
                  ? "Imported from Spotify"
                  : artist.manuallyAdded
                    ? watchlistMode === "mock"
                      ? "Added manually in mock mode"
                      : "Added manually"
                    : `${artist.releases.length} discovery signal`}
              </small>
            </div>
            <div className="source-stack">
              {artist.providers.filter(
                (provider) => musicbrainzEnabled || provider !== "musicbrainz",
              ).length === 0 ? (
                <span className="provider-tag">No provider IDs</span>
              ) : (
                artist.providers
                  .filter((provider) => musicbrainzEnabled || provider !== "musicbrainz")
                  .map((provider) => (
                    <span className="provider-tag" key={provider}>
                      {provider}
                    </span>
                  ))
              )}
              {artist.providers.includes("spotify") && (
                <span
                  className="provider-tag"
                  title={spotifyCoverageDetail(artist.spotifyCoverage ?? null)}
                >
                  {spotifyCoverageLabel(artist.spotifyCoverage ?? null)}
                </span>
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
            <span
              className={`mapping-status ${artist.manuallyAdded || !artist.active ? "pending" : ""}`}
            >
              {artist.manuallyAdded || !artist.active ? <Clock3 size={14} /> : <Check size={14} />}
              {!artist.active ? "Paused" : artist.manuallyAdded ? "Pending mapping" : "Mapped"}
            </span>
            <div className="row-actions">
              {musicbrainzEnabled && (
                <>
                  <button
                    aria-label={`${
                      artist.providers.includes("musicbrainz") ? "View" : "Map"
                    } ${artist.name} MusicBrainz mapping`}
                    className="icon-button small"
                    disabled={
                      !musicbrainzConfigured ||
                      watchlistMode !== "database" ||
                      !z.string().uuid().safeParse(artist.id).success
                    }
                    onClick={() => void openMusicBrainzMapping(artist)}
                    title="View MusicBrainz mapping"
                  >
                    <Link2 size={15} />
                  </button>
                  <button
                    aria-label={`Run MusicBrainz scan for ${artist.name}`}
                    className="icon-button small"
                    disabled={
                      !musicbrainzConfigured ||
                      !artist.providers.includes("musicbrainz") ||
                      watchlistMode !== "database"
                    }
                    onClick={() => onScanArtist(artist.id)}
                    title="Scan this artist with MusicBrainz"
                  >
                    <RefreshCw size={15} />
                  </button>
                </>
              )}
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
  initialSummary,
  items,
  onNotice,
  spotifyConfiguration,
}: {
  initialSummary: SpotifyPlaylistDashboardSummary;
  items: FeedFixtureItem[];
  onNotice: (message: string) => void;
  spotifyConfiguration: ProviderUiConfiguration["spotify"];
}) {
  const [summary, setSummary] = useState(initialSummary);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{
    additions: Array<{
      position: number;
      providerTrackId: string;
      releaseDate: string;
      releaseTitle: string;
      title: string;
    }>;
    skipCounts: Record<string, number>;
    target: { id: string; idAbbreviated: string; name: string; public: boolean | null };
    totals: {
      additions: number;
      alreadyPresent: number;
      eligible: number;
      orderingConflicts: number;
      skipped: number;
    };
  } | null>(null);
  const [inspectedPlaylist, setInspectedPlaylist] = useState<{
    collaborative: false;
    id: string;
    name: string;
    public: boolean | null;
  } | null>(null);

  const playlistRequest = async (path: string, method: "GET" | "POST") => {
    setBusy(true);
    try {
      const response = await fetch(path, { method });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error("Spotify playlist request failed");
      return payload;
    } finally {
      setBusy(false);
    }
  };

  const previewSync = async () => {
    try {
      const payload = z
        .object({
          additions: z.array(
            z.object({
              position: z.number().int().nonnegative(),
              providerTrackId: z.string(),
              releaseDate: z.string(),
              releaseTitle: z.string(),
              title: z.string(),
            }),
          ),
          skipCounts: z.record(z.string(), z.number().int().nonnegative()),
          target: z.object({
            id: z.string(),
            idAbbreviated: z.string(),
            name: z.string(),
            public: z.boolean().nullable(),
          }),
          totals: z.object({
            additions: z.number().int().nonnegative(),
            alreadyPresent: z.number().int().nonnegative(),
            eligible: z.number().int().nonnegative(),
            orderingConflicts: z.number().int().nonnegative(),
            skipped: z.number().int().nonnegative(),
          }),
        })
        .passthrough()
        .parse(await playlistRequest("/api/spotify/playlist-sync", "GET"));
      setPreview(payload);
      setSummary({
        blocked: [
          "malformed_spotify_track_id",
          "missing_spotify_match",
          "needs_review",
          "uncertain_spotify_match",
        ].reduce((total, reason) => total + (payload.skipCounts[reason] ?? 0), 0),
        exported: payload.totals.alreadyPresent,
        pendingReorderMoves: payload.totals.orderingConflicts,
        ready: payload.totals.additions,
      });
    } catch {
      onNotice("Unable to preview Spotify playlist synchronization.");
    }
  };

  const syncPlaylist = async () => {
    try {
      const payload = z
        .object({
          run: z.object({
            additionsAttempted: z.number().int().nonnegative(),
            failed: z.number().int().nonnegative(),
            pending: z.number().int().nonnegative(),
            status: z.enum(["completed", "partial"]),
          }),
        })
        .passthrough()
        .parse(await playlistRequest("/api/spotify/playlist-sync", "POST"));
      onNotice(
        `Spotify add-only export ${payload.run.status}. ${payload.run.additionsAttempted} additions attempted, ${payload.run.failed} failed, ${payload.run.pending} pending.`,
      );
      await previewSync();
    } catch {
      onNotice("Unable to synchronize the Spotify playlist.");
    }
  };

  const inspectPlaylist = async () => {
    try {
      const payload = z
        .object({
          playlist: z
            .object({
              collaborative: z.literal(false),
              id: z.string(),
              name: z.string(),
              public: z.boolean().nullable(),
            })
            .nullable(),
        })
        .parse(await playlistRequest("/api/spotify/playlists", "GET"));
      setInspectedPlaylist(payload.playlist);
      onNotice(
        payload.playlist
          ? `Configured ${payload.playlist.public ? "public" : "private"} playlist ${payload.playlist.name} was verified.`
          : "No Spotify playlist ID is configured.",
      );
    } catch {
      onNotice("Unable to inspect the configured Spotify playlist.");
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
              <h2>Spotify public release inbox</h2>
              <p>
                {spotifyConfiguration.allowedPlaylistConfigured
                  ? `Configured target ${spotifyConfiguration.allowedPlaylistIdAbbreviated}`
                  : "No allowed playlist ID configured"}
              </p>
            </div>
          </div>
          <dl>
            <div>
              <dt>Ready</dt>
              <dd>{summary.ready}</dd>
            </div>
            <div>
              <dt>Exported</dt>
              <dd>{summary.exported}</dd>
            </div>
            <div>
              <dt>Blocked</dt>
              <dd>{summary.blocked}</dd>
            </div>
          </dl>
          <div className="row-actions">
            <button
              className="secondary-button"
              disabled={
                !spotifyConfiguration.configured ||
                !spotifyConfiguration.allowedPlaylistConfigured ||
                busy
              }
              onClick={() => void inspectPlaylist()}
              type="button"
            >
              Inspect configured playlist
            </button>
            <button
              className="secondary-button"
              disabled={
                !spotifyConfiguration.configured ||
                !spotifyConfiguration.allowedPlaylistConfigured ||
                busy
              }
              onClick={() => void previewSync()}
              type="button"
            >
              Preview sync
            </button>
            <button
              className="secondary-button"
              disabled={
                !spotifyConfiguration.configured ||
                !spotifyConfiguration.allowedPlaylistConfigured ||
                !spotifyConfiguration.playlistWritesEnabled ||
                busy
              }
              onClick={() => void syncPlaylist()}
              type="button"
            >
              <RefreshCw size={15} />
              {spotifyConfiguration.playlistWritesEnabled
                ? "Run live add-only export"
                : "Playlist writes disabled"}
            </button>
          </div>
          {inspectedPlaylist && (
            <div className="sync-preview" role="status">
              <span>{inspectedPlaylist.name}</span>
              <span>{inspectedPlaylist.id}</span>
              <span>
                Owned, {inspectedPlaylist.public ? "public" : "private"}, and non-collaborative
              </span>
            </div>
          )}
          {preview && (
            <div className="sync-preview" role="status">
              <span>{preview.target.name}</span>
              <span>{preview.target.id}</span>
              <span>{preview.totals.additions} to add</span>
              <span>{preview.totals.alreadyPresent} already present</span>
              <span>{preview.totals.skipped} skipped</span>
              <span>{preview.totals.orderingConflicts} pending reorder moves</span>
              {Object.entries(preview.skipCounts).map(([reason, count]) => (
                <span key={reason}>
                  {count} {reason.replaceAll("_", " ")}
                </span>
              ))}
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

function providerDisplayName(provider: "apple_music" | "musicbrainz" | "spotify"): string {
  if (provider === "apple_music") return "Apple Music";
  return provider === "musicbrainz" ? "MusicBrainz" : "Spotify";
}

function reviewProviderDisplayName(
  provider: FeedFixtureItem["review"] extends infer Review
    ? Review extends { provider: infer Provider }
      ? Provider
      : never
    : never,
): string {
  if (provider === "apple_music") return "Apple Music";
  if (provider === "musicbrainz") return "MusicBrainz";
  if (provider === "spotify") return "Spotify";
  if (provider === "reddit") return "Reddit";
  return provider === "mock" ? "Mock provider" : provider;
}

function findReviewSpotifyUrl(
  item: FeedFixtureItem,
  reviewItems: FeedFixtureItem[],
): string | undefined {
  const directEvidence = item.sources.find(
    (source) => source.provider.toLocaleLowerCase("en-US") === "spotify",
  )?.href;
  if (directEvidence) return directEvidence;
  if (item.review?.provider === "spotify" && item.review.providerUrl) {
    return item.review.providerUrl;
  }

  const siblingSpotifyUrls = [
    ...new Set(
      reviewItems.flatMap((candidate) =>
        candidate.review?.provider === "spotify" &&
        candidate.review.providerUrl &&
        sameReviewRelease(item, candidate)
          ? [candidate.review.providerUrl]
          : [],
      ),
    ),
  ];
  return siblingSpotifyUrls.length === 1 ? siblingSpotifyUrls[0] : undefined;
}

function findReviewProviderSource(item: FeedFixtureItem, provider: string) {
  const normalizedProvider = provider.replace("_", " ").toLocaleLowerCase("en-US");
  return item.sources.find(
    (source) => source.provider.replace("_", " ").toLocaleLowerCase("en-US") === normalizedProvider,
  );
}

function sameReviewRelease(left: FeedFixtureItem, right: FeedFixtureItem): boolean {
  const normalize = (value: string) =>
    value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
  return (
    normalize(left.title) === normalize(right.title) &&
    normalize(left.artist) === normalize(right.artist) &&
    left.releaseDate === right.releaseDate &&
    left.releaseType === right.releaseType
  );
}

function summarizeMappingReviews(reviews: Array<{ artistId: string }>): {
  pendingCandidates: number;
  unresolvedArtists: number;
} {
  return {
    pendingCandidates: reviews.length,
    unresolvedArtists: new Set(reviews.map((review) => review.artistId)).size,
  };
}

function groupMappingReviews<
  T extends {
    artistId: string;
    artistName: string;
    confirmedEvidence: Array<{
      externalId: string;
      mappingSource: string;
      provider: "apple_music" | "musicbrainz" | "spotify";
      url: string | null;
    }>;
    provider: "apple_music" | "musicbrainz";
  },
>(reviews: T[]) {
  const groups = new Map<
    string,
    {
      artistId: string;
      artistName: string;
      candidates: T[];
      confirmedEvidence: T["confirmedEvidence"];
      provider: T["provider"];
    }
  >();
  for (const review of reviews) {
    const key = `${review.provider}:${review.artistId}`;
    const current = groups.get(key);
    if (current) current.candidates.push(review);
    else {
      groups.set(key, {
        artistId: review.artistId,
        artistName: review.artistName,
        candidates: [review],
        confirmedEvidence: review.confirmedEvidence,
        provider: review.provider,
      });
    }
  }
  return [...groups.values()];
}

interface AppleMappingCandidateEvidence {
  activityDate: string | null;
  appleArtistName: string;
  artistUrl: string | null;
  artworkUrl: string | null;
  autoConfirmEligible: boolean;
  collaborators: string[];
  contradictions: string[];
  eliminationSafe: boolean;
  exactLinkSource: string | null;
  genres: string[];
  labels: string[];
  rank: number;
  rankingReasons: string[];
  resourceStatus: string;
  score: string;
  source: string;
  titleOverlaps: Array<{
    distinctive: boolean;
    leftTitle: string;
    rightTitle: string;
    weight: number;
  }>;
  topReleases: Array<{
    artworkUrl?: string | undefined;
    releaseDate?: string | undefined;
    title: string;
  }>;
  topSongs: Array<{
    artworkUrl?: string | undefined;
    releaseDate?: string | undefined;
    title: string;
  }>;
}

interface ReleaseReviewQueueStatusView {
  actionableCount: number;
  blockedExport: {
    stale: number;
    systemWaiting: number;
    terminal: number;
    total: number;
    userActionable: number;
  };
  deferredCount: number;
  staleCount: number;
  systemWaiting: Array<{
    attemptCount: number;
    dueAt: string;
    id: string;
    notBefore: string | null;
    reason: string;
    releaseTitle: string;
    source: string;
    status: string;
    title: string;
    trackId: string;
  }>;
  systemWaitingCount: number;
  terminalCount: number;
}

function ReviewView({
  databaseMode,
  items,
  musicbrainzEnabled,
  onDecision,
  pendingItemIds,
  query,
}: {
  databaseMode: boolean;
  items: FeedFixtureItem[];
  musicbrainzEnabled: boolean;
  onDecision: (
    item: FeedFixtureItem,
    decision: ReleaseReviewDecision,
    spotifyTrackId?: string,
  ) => void;
  pendingItemIds: string[];
  query: string;
}) {
  const [reviewFilter, setReviewFilter] = useState<
    "all" | "matches" | "musicbrainz_mappings" | "apple_music_mappings"
  >("all");
  const [mappingReviews, setMappingReviews] = useState<
    Array<{
      artistId: string;
      artistName: string;
      confirmedEvidence: Array<{
        externalId: string;
        mappingSource: string;
        provider: "apple_music" | "musicbrainz" | "spotify";
        url: string | null;
      }>;
      confidence: string;
      candidateEvidence?: AppleMappingCandidateEvidence | undefined;
      id: string;
      name: string;
      proposedExternalId: string | null;
      provider: "apple_music" | "musicbrainz";
      reasons: string[];
      status: string;
    }>
  >([]);
  const [mappingReviewCursors, setMappingReviewCursors] = useState<
    Record<"apple_music" | "musicbrainz", string | null>
  >({ apple_music: null, musicbrainz: null });
  const [mappingReviewHasMore, setMappingReviewHasMore] = useState<
    Record<"apple_music" | "musicbrainz", boolean>
  >({ apple_music: false, musicbrainz: false });
  const [mappingReviewSummaries, setMappingReviewSummaries] = useState<
    Record<"apple_music" | "musicbrainz", { pendingCandidates: number; unresolvedArtists: number }>
  >({
    apple_music: { pendingCandidates: 0, unresolvedArtists: 0 },
    musicbrainz: { pendingCandidates: 0, unresolvedArtists: 0 },
  });
  const [mappingReviewState, setMappingReviewState] = useState<"loading" | "loaded" | "error">(
    "loading",
  );
  const [mappingDecisionIds, setMappingDecisionIds] = useState<string[]>([]);
  const [mappingDecisionError, setMappingDecisionError] = useState<string | null>(null);
  const [splitSelections, setSplitSelections] = useState<Record<string, string[]>>({});
  const [releaseQueueStatus, setReleaseQueueStatus] = useState<ReleaseReviewQueueStatusView | null>(
    null,
  );
  const [releaseQueueStatusError, setReleaseQueueStatusError] = useState(false);
  const normalizedQuery = query.trim().toLocaleLowerCase("en-US");
  const visibleItems = items.filter((item) =>
    `${item.artist} ${item.title}`.toLocaleLowerCase("en-US").includes(normalizedQuery),
  );

  const loadReleaseQueueStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/reviews/status", { cache: "no-store" });
      if (!response.ok) throw new Error("Review status unavailable");
      const parsed = releaseReviewQueueStatusResponseSchema.parse(await response.json());
      setReleaseQueueStatus(parsed.status);
      setReleaseQueueStatusError(false);
    } catch {
      setReleaseQueueStatusError(true);
    }
  }, []);

  useEffect(() => {
    if (databaseMode) void loadReleaseQueueStatus();
  }, [databaseMode, loadReleaseQueueStatus]);

  const loadMappingReviews = useCallback(async () => {
    setMappingReviewState("loading");
    try {
      const providers = musicbrainzEnabled
        ? (["musicbrainz", "apple_music"] as const)
        : (["apple_music"] as const);
      const loaded = await Promise.all(
        providers.map(async (provider) => {
          try {
            const response = await fetch(`/api/${provider.replace("_", "-")}/mappings?limit=50`, {
              cache: "no-store",
            });
            if (!response.ok) return null;
            return [provider, mappingReviewPageSchema.parse(await response.json())] as const;
          } catch {
            return null;
          }
        }),
      );
      const pages = loaded.filter((page) => page !== null);
      if (pages.length === 0) throw new Error("Mapping reviews unavailable");
      setMappingReviews(
        pages.flatMap(([provider, page]) =>
          page.reviews.filter(
            (review) =>
              review.status === "pending" ||
              (provider === "apple_music" && review.status === "rejected"),
          ),
        ),
      );
      setMappingReviewSummaries((current) => ({
        ...current,
        ...Object.fromEntries(
          pages.map(([provider, page]) => [
            provider,
            page.summary ?? summarizeMappingReviews(page.reviews),
          ]),
        ),
      }));
      setMappingReviewCursors(
        Object.fromEntries(pages.map(([provider, page]) => [provider, page.nextCursor])) as Record<
          "apple_music" | "musicbrainz",
          string | null
        >,
      );
      setMappingReviewHasMore(
        Object.fromEntries(pages.map(([provider, page]) => [provider, page.hasMore])) as Record<
          "apple_music" | "musicbrainz",
          boolean
        >,
      );
      setMappingReviewState("loaded");
    } catch {
      setMappingReviewState("error");
    }
  }, [musicbrainzEnabled]);

  useEffect(() => {
    void loadMappingReviews();
  }, [loadMappingReviews]);

  const loadOlderMappingReviews = async (provider: "apple_music" | "musicbrainz") => {
    const cursor = mappingReviewCursors[provider];
    if (!cursor) return;
    setMappingReviewState("loading");
    try {
      const parameters = new URLSearchParams({ cursor, limit: "50" });
      const response = await fetch(
        `/api/${provider.replace("_", "-")}/mappings?${parameters.toString()}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error("Mapping reviews unavailable");
      const payload = mappingReviewPageSchema.parse(await response.json());
      setMappingReviews((current) =>
        mergeById(
          current,
          payload.reviews.filter(
            (review) =>
              review.status === "pending" ||
              (provider === "apple_music" && review.status === "rejected"),
          ),
        ),
      );
      setMappingReviewCursors((current) => ({ ...current, [provider]: payload.nextCursor }));
      setMappingReviewHasMore((current) => ({ ...current, [provider]: payload.hasMore }));
      setMappingReviewSummaries((current) => ({
        ...current,
        [provider]: payload.summary ?? current[provider],
      }));
      setMappingReviewState("loaded");
    } catch {
      setMappingReviewState("error");
    }
  };

  const decideMapping = async (
    review: (typeof mappingReviews)[number],
    decision: "confirm" | "reject" | "restore",
  ) => {
    setMappingDecisionIds((current) => [...current, review.id]);
    const response = await fetch(`/api/${review.provider.replace("_", "-")}/mappings/decision`, {
      body: JSON.stringify({ decision, reviewId: review.id }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (response.ok) {
      await loadMappingReviews();
    }
    setMappingDecisionIds((current) => current.filter((id) => id !== review.id));
  };

  const decideIdentityStatus = async (
    review: (typeof mappingReviews)[number],
    status: "confirmed_unavailable" | "intentionally_deferred" | "split_profile",
    externalIds: string[] = [],
  ) => {
    const groupKey = `${review.provider}:${review.artistId}`;
    setMappingDecisionIds((current) => [...current, groupKey]);
    setMappingDecisionError(null);
    try {
      const response = await fetch("/api/artist-identities/decision", {
        body: JSON.stringify({
          artistId: review.artistId,
          ...(externalIds.length ? { externalIds } : {}),
          provider: review.provider,
          status,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Identity decision failed");
      }
      setSplitSelections((current) => {
        const next = { ...current };
        delete next[groupKey];
        return next;
      });
      await loadMappingReviews();
    } catch (error) {
      setMappingDecisionError(
        error instanceof Error ? error.message : "Unable to save the identity decision.",
      );
    } finally {
      setMappingDecisionIds((current) => current.filter((id) => id !== groupKey));
    }
  };

  const toggleSplitCandidate = (groupKey: string, appleArtistId: string) => {
    setSplitSelections((current) => {
      const selected = new Set(current[groupKey] ?? []);
      if (selected.has(appleArtistId)) selected.delete(appleArtistId);
      else selected.add(appleArtistId);
      return { ...current, [groupKey]: [...selected] };
    });
  };

  const filteredMappingReviews = mappingReviews.filter((review) =>
    reviewFilter === "musicbrainz_mappings"
      ? review.provider === "musicbrainz"
      : reviewFilter === "apple_music_mappings"
        ? review.provider === "apple_music"
        : true,
  );
  const filteredMappingReviewGroups = groupMappingReviews(filteredMappingReviews);
  const visibleMappingSummary =
    reviewFilter === "apple_music_mappings"
      ? mappingReviewSummaries.apple_music
      : reviewFilter === "musicbrainz_mappings"
        ? mappingReviewSummaries.musicbrainz
        : {
            pendingCandidates:
              mappingReviewSummaries.apple_music.pendingCandidates +
              mappingReviewSummaries.musicbrainz.pendingCandidates,
            unresolvedArtists:
              mappingReviewSummaries.apple_music.unresolvedArtists +
              mappingReviewSummaries.musicbrainz.unresolvedArtists,
          };

  return (
    <section className="content standard-view">
      <div className="page-heading">
        <div>
          <p className="eyebrow">AUTOMATION BLOCKED</p>
          <h1>Review queue</h1>
          <p>Ambiguous matches require an explicit decision before playlist export.</p>
        </div>
      </div>
      <label className="sort-control">
        <span>Review type</span>
        <select
          aria-label="Filter review queue"
          onChange={(event) => setReviewFilter(event.target.value as typeof reviewFilter)}
          value={reviewFilter}
        >
          <option value="all">All reviews</option>
          <option value="matches">Release matches</option>
          {musicbrainzEnabled && <option value="musicbrainz_mappings">MusicBrainz mappings</option>}
          <option value="apple_music_mappings">Apple Music mappings</option>
        </select>
      </label>
      <div className="review-list">
        {(reviewFilter === "all" || reviewFilter === "matches") && releaseQueueStatus && (
          <section className="review-queue-overview" aria-label="Release review classification">
            <div className="review-queue-counts">
              <span>
                <strong>{releaseQueueStatus.actionableCount}</strong> manual candidate records
              </span>
              <span>
                <strong>{releaseQueueStatus.blockedExport.total}</strong> blocked export tracks
              </span>
              <span>
                <strong>{releaseQueueStatus.blockedExport.userActionable}</strong> user-actionable
                blocks
              </span>
              <span>
                <strong>{releaseQueueStatus.blockedExport.systemWaiting}</strong> system-waiting
                blocks
              </span>
              <span>
                <strong>{releaseQueueStatus.blockedExport.terminal}</strong> no-equivalent blocks
              </span>
              <span>
                <strong>{releaseQueueStatus.deferredCount}</strong> deferred
              </span>
              <span>
                <strong>{releaseQueueStatus.blockedExport.stale}</strong> stale blocks
              </span>
            </div>
            {releaseQueueStatus.systemWaitingCount > 0 && (
              <details className="system-waiting-reviews">
                <summary>System-waiting records</summary>
                <p>
                  These do not need a manual decision. The scanner will retry them through the
                  existing Spotify request gate when queue order, cooldown, and capacity allow.
                </p>
                <div className="system-waiting-list">
                  {releaseQueueStatus.systemWaiting.map((waiting) => (
                    <article key={waiting.trackId}>
                      <div>
                        <strong>{waiting.title}</strong>
                        <span>{waiting.releaseTitle}</span>
                      </div>
                      <div>
                        <span>{waiting.status.replaceAll("_", " ")}</span>
                        <small>{waiting.reason}</small>
                      </div>
                    </article>
                  ))}
                </div>
              </details>
            )}
          </section>
        )}
        {(reviewFilter === "all" || reviewFilter === "matches") && releaseQueueStatusError && (
          <div className="form-error" role="alert">
            System-waiting review status is temporarily unavailable.
          </div>
        )}
        {reviewFilter !== "matches" &&
          mappingReviewState === "loading" &&
          mappingReviews.length === 0 && (
            <div className="empty-inline">Loading mapping reviews...</div>
          )}
        {reviewFilter !== "matches" && mappingReviewState === "error" && (
          <div className="form-error" role="alert">
            Provider mapping reviews are temporarily unavailable.
          </div>
        )}
        {reviewFilter !== "matches" && mappingDecisionError && (
          <div className="form-error" role="alert">
            {mappingDecisionError}
          </div>
        )}
        {reviewFilter !== "matches" && mappingReviewState !== "error" && (
          <div className="mapping-review-summary" role="status">
            <strong>{visibleMappingSummary.unresolvedArtists} unresolved artists</strong>
            <span>{visibleMappingSummary.pendingCandidates} candidate identities</span>
          </div>
        )}
        {reviewFilter !== "matches" &&
          filteredMappingReviewGroups.map((group) => {
            const groupKey = `${group.provider}:${group.artistId}`;
            const groupPending = mappingDecisionIds.includes(groupKey);
            const selectedSplitIds = splitSelections[groupKey] ?? [];
            return (
              <section
                aria-label={`${group.artistName} ${providerDisplayName(group.provider)} identity review`}
                className="mapping-review-group"
                key={`${group.provider}:${group.artistId}`}
              >
                <div className="mapping-review-group-heading">
                  <div>
                    <span className="state state-needs_review">
                      {providerDisplayName(group.provider)} mapping
                    </span>
                    <h2>{group.artistName}</h2>
                    <small>
                      Canonical artist | {group.candidates.length} candidate
                      {group.candidates.length === 1 ? "" : "s"}
                    </small>
                  </div>
                  {group.provider === "apple_music" && (
                    <div className="review-actions">
                      <button
                        className="secondary-button"
                        disabled={groupPending}
                        onClick={() =>
                          void decideIdentityStatus(group.candidates[0]!, "confirmed_unavailable")
                        }
                        type="button"
                      >
                        Not on Apple
                      </button>
                      <button
                        className="secondary-button"
                        disabled={groupPending}
                        onClick={() =>
                          void decideIdentityStatus(group.candidates[0]!, "intentionally_deferred")
                        }
                        type="button"
                      >
                        Defer
                      </button>
                      <button
                        className="secondary-button"
                        disabled={groupPending || selectedSplitIds.length < 2}
                        onClick={() =>
                          void decideIdentityStatus(
                            group.candidates[0]!,
                            "split_profile",
                            selectedSplitIds,
                          )
                        }
                        type="button"
                      >
                        Confirm split profile
                      </button>
                    </div>
                  )}
                </div>
                {group.confirmedEvidence.length > 0 && (
                  <div className="mapping-confirmed-evidence">
                    <strong>Confirmed identity evidence</strong>
                    {group.confirmedEvidence.map((evidence) =>
                      evidence.url ? (
                        <a
                          href={evidence.url}
                          key={`${evidence.provider}:${evidence.externalId}`}
                          rel="noopener noreferrer"
                          target="_blank"
                        >
                          {providerDisplayName(evidence.provider)} {evidence.externalId}
                          <ExternalLink size={12} />
                        </a>
                      ) : (
                        <span key={`${evidence.provider}:${evidence.externalId}`}>
                          {providerDisplayName(evidence.provider)} {evidence.externalId}
                        </span>
                      ),
                    )}
                  </div>
                )}
                {group.candidates.map((review) => {
                  const evidence = review.candidateEvidence;
                  const candidateName = evidence?.appleArtistName ?? review.name;
                  const candidateUrl = review.proposedExternalId
                    ? (evidence?.artistUrl ??
                      (review.provider === "musicbrainz"
                        ? `https://musicbrainz.org/artist/${review.proposedExternalId}`
                        : `https://music.apple.com/us/artist/${review.proposedExternalId}`))
                    : null;
                  const splitEligible = Boolean(
                    review.provider === "apple_music" &&
                    review.status === "pending" &&
                    review.proposedExternalId &&
                    evidence?.resourceStatus === "valid",
                  );
                  return (
                    <article
                      className={`review-card${evidence ? " mapping-candidate-card" : ""}`}
                      key={review.id}
                    >
                      <div className="mapping-candidate-body">
                        {evidence?.artworkUrl && candidateUrl && (
                          <a
                            aria-label={`Open ${candidateName} on Apple Music`}
                            className="mapping-candidate-artwork"
                            href={candidateUrl}
                            rel="noopener noreferrer"
                            target="_blank"
                          >
                            <img
                              alt={`Apple catalog artwork for ${candidateName}`}
                              height={100}
                              loading="lazy"
                              src={evidence.artworkUrl}
                              width={100}
                            />
                          </a>
                        )}
                        <div className="mapping-candidate-copy">
                          <div className="mapping-candidate-flags">
                            {evidence && <span>Rank {evidence.rank}</span>}
                            {review.status === "rejected" && <span>Rejected</span>}
                            {evidence?.exactLinkSource && <span>Exact independent link</span>}
                            {evidence?.contradictions.length ? <span>Conflict</span> : null}
                          </div>
                          <strong>{candidateName}</strong>
                          <p>
                            {review.proposedExternalId
                              ? `${providerDisplayName(review.provider)} artist ID ${review.proposedExternalId}`
                              : `No ${providerDisplayName(review.provider)} candidate found`}
                          </p>
                          {evidence ? (
                            <div className="mapping-candidate-evidence">
                              <p>
                                {Math.round(Number(evidence.score) * 100)}% advisory score |{" "}
                                {evidence.resourceStatus} {evidence.source.replaceAll("_", " ")}
                              </p>
                              <dl>
                                <div>
                                  <dt>Genres</dt>
                                  <dd>{evidence.genres.join(", ") || "Unavailable"}</dd>
                                </div>
                                <div>
                                  <dt>Labels</dt>
                                  <dd>{evidence.labels.join(", ") || "Unavailable"}</dd>
                                </div>
                                <div>
                                  <dt>Activity</dt>
                                  <dd>{evidence.activityDate ?? "Unavailable"}</dd>
                                </div>
                                <div>
                                  <dt>Collaborators</dt>
                                  <dd>{evidence.collaborators.join(", ") || "None observed"}</dd>
                                </div>
                              </dl>
                              {evidence.topReleases.length > 0 && (
                                <div className="mapping-candidate-catalog-list">
                                  <b>Top releases</b>
                                  <span>
                                    {evidence.topReleases
                                      .map((release) =>
                                        release.releaseDate
                                          ? `${release.title} (${release.releaseDate.slice(0, 10)})`
                                          : release.title,
                                      )
                                      .join(" | ")}
                                  </span>
                                </div>
                              )}
                              {evidence.titleOverlaps.length > 0 && (
                                <div className="mapping-candidate-catalog-list">
                                  <b>Title overlaps</b>
                                  <span>
                                    {evidence.titleOverlaps
                                      .map((overlap) => overlap.leftTitle)
                                      .join(" | ")}
                                  </span>
                                </div>
                              )}
                              {evidence.contradictions.map((contradiction) => (
                                <p className="mapping-candidate-warning" key={contradiction}>
                                  {contradiction}
                                </p>
                              ))}
                              <small>{evidence.rankingReasons.join(" ")}</small>
                            </div>
                          ) : (
                            <small>Apple-only catalog evidence has not been fetched yet.</small>
                          )}
                        </div>
                      </div>
                      <div className="review-actions mapping-candidate-actions">
                        {splitEligible && review.proposedExternalId && (
                          <label className="mapping-split-choice">
                            <input
                              checked={selectedSplitIds.includes(review.proposedExternalId)}
                              disabled={groupPending}
                              onChange={() =>
                                toggleSplitCandidate(groupKey, review.proposedExternalId!)
                              }
                              type="checkbox"
                            />
                            Split profile
                          </label>
                        )}
                        {candidateUrl ? (
                          <a
                            className="secondary-button"
                            href={candidateUrl}
                            rel="noopener noreferrer"
                            target="_blank"
                          >
                            Open candidate <ExternalLink size={13} />
                          </a>
                        ) : (
                          <AppleMusicManualMappingForm
                            artistId={review.artistId}
                            disabled={mappingDecisionIds.includes(review.id) || groupPending}
                            onSaved={() => void loadMappingReviews()}
                          />
                        )}
                        <button
                          className="secondary-button"
                          disabled={mappingDecisionIds.includes(review.id) || groupPending}
                          onClick={() =>
                            void decideMapping(
                              review,
                              review.status === "rejected" ? "restore" : "reject",
                            )
                          }
                          type="button"
                        >
                          {review.status === "rejected" ? "Restore candidate" : "Reject candidate"}
                        </button>
                        <button
                          className="primary-button"
                          disabled={
                            !review.proposedExternalId ||
                            review.status === "rejected" ||
                            mappingDecisionIds.includes(review.id) ||
                            groupPending
                          }
                          onClick={() => void decideMapping(review, "confirm")}
                          type="button"
                        >
                          Confirm identity
                        </button>
                      </div>
                    </article>
                  );
                })}
              </section>
            );
          })}
        {reviewFilter !== "matches" &&
          (musicbrainzEnabled
            ? (["musicbrainz", "apple_music"] as const)
            : (["apple_music"] as const)
          ).map((provider) =>
            mappingReviewHasMore[provider] &&
            (reviewFilter === "all" || reviewFilter === `${provider}_mappings`) ? (
              <button
                className="secondary-button review-load-more"
                disabled={mappingReviewState === "loading"}
                key={provider}
                onClick={() => void loadOlderMappingReviews(provider)}
                type="button"
              >
                {mappingReviewState === "loading"
                  ? "Loading reviews"
                  : provider === "musicbrainz"
                    ? "Load older mapping reviews"
                    : "Load older Apple Music reviews"}
              </button>
            ) : null,
          )}
        {reviewFilter !== "musicbrainz_mappings" &&
        reviewFilter !== "apple_music_mappings" &&
        visibleItems.length ? (
          visibleItems.map((item) => {
            const pending = pendingItemIds.includes(item.id);
            const candidateProvider = item.review?.provider ?? "mock";
            const spotifyReviewUrl = findReviewSpotifyUrl(item, items);
            const candidateArtwork =
              candidateProvider === "apple_music"
                ? item.appleMusicArtwork?.image.url
                : candidateProvider === "spotify"
                  ? item.spotifyArtwork?.image.url
                  : undefined;
            const comparisonArtwork =
              candidateProvider === "apple_music"
                ? item.spotifyArtwork?.image.url
                : item.appleMusicArtwork?.image.url;
            const comparisonProvider =
              candidateProvider === "apple_music"
                ? "spotify"
                : candidateProvider === "spotify"
                  ? "apple_music"
                  : null;
            const comparisonSource = comparisonProvider
              ? findReviewProviderSource(item, comparisonProvider)
              : undefined;
            return (
              <article className="review-card release-review-card" key={item.id}>
                <div className="release-review-heading">
                  <span className="state state-needs_review">Needs review</span>
                  <h2>{item.title}</h2>
                  <p>{item.artist}</p>
                  <small>
                    {Math.round(item.confidence * 100)}% confidence | {item.matchReason}
                  </small>
                  {spotifyReviewUrl ? (
                    <a
                      className="review-spotify-link"
                      href={spotifyReviewUrl}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      Open Spotify track for {item.title} <ExternalLink size={13} />
                    </a>
                  ) : (
                    <span className="review-spotify-link-missing">
                      No stored Spotify track link is available yet. Retry matching or paste the
                      verified track link below.
                    </span>
                  )}
                </div>
                <div className="release-review-comparison">
                  <section>
                    <span>{reviewProviderDisplayName(candidateProvider)} candidate</span>
                    {candidateArtwork && (
                      <img alt="Candidate release artwork" src={candidateArtwork} />
                    )}
                    <strong>{item.releaseTitle}</strong>
                    <p>{item.artist}</p>
                    <small>
                      {item.releaseType} | {item.releaseDate}
                    </small>
                    <b>Track list</b>
                    <ol>
                      <li>{item.title}</li>
                    </ol>
                    {item.review?.providerUrl && (
                      <a href={item.review.providerUrl} rel="noopener noreferrer" target="_blank">
                        Open {reviewProviderDisplayName(candidateProvider)} candidate{" "}
                        <ExternalLink size={12} />
                      </a>
                    )}
                  </section>
                  <section>
                    <span>
                      {comparisonProvider
                        ? `${reviewProviderDisplayName(comparisonProvider)} comparison`
                        : "Canonical comparison"}
                    </span>
                    {comparisonArtwork && (
                      <img alt="Comparison release artwork" src={comparisonArtwork} />
                    )}
                    <strong>{item.artist}</strong>
                    <p>{item.releaseTitle}</p>
                    <small>
                      {item.releaseType} | {item.releaseDate}
                    </small>
                    <b>Track list</b>
                    <ol>
                      <li>{item.title}</li>
                    </ol>
                    {comparisonProvider &&
                      (comparisonProvider === "spotify" ? spotifyReviewUrl : comparisonSource) && (
                        <a
                          href={
                            comparisonProvider === "spotify"
                              ? spotifyReviewUrl
                              : comparisonSource?.href
                          }
                          rel="noopener noreferrer"
                          target="_blank"
                        >
                          Open {reviewProviderDisplayName(comparisonProvider)} evidence{" "}
                          <ExternalLink size={12} />
                        </a>
                      )}
                    <b>Evidence</b>
                    <p>{item.matchReason}</p>
                    <div className="review-provider-links">
                      {item.sources.map((source) => (
                        <a
                          key={`${source.provider}:${source.href}`}
                          href={source.href}
                          rel="noopener noreferrer"
                          target="_blank"
                        >
                          {source.provider} <ExternalLink size={12} />
                        </a>
                      ))}
                    </div>
                  </section>
                </div>
                <div className="review-actions">
                  <button
                    className="secondary-button"
                    disabled={pending}
                    onClick={() => onDecision(item, "defer")}
                    type="button"
                  >
                    Defer 7 days
                  </button>
                  <button
                    className="secondary-button"
                    disabled={pending}
                    onClick={() => onDecision(item, "retry")}
                    type="button"
                  >
                    Retry matching
                  </button>
                  <button
                    className="secondary-button"
                    disabled={pending}
                    onClick={() => onDecision(item, "separate")}
                    type="button"
                  >
                    Keep separate
                  </button>
                  {candidateProvider !== "spotify" && (
                    <button
                      className="secondary-button"
                      disabled={pending}
                      onClick={() => onDecision(item, "no_equivalent")}
                      type="button"
                    >
                      No Spotify equivalent
                    </button>
                  )}
                  <ManualSpotifyTrackReviewAction
                    disabled={pending}
                    item={item}
                    onConfirm={(spotifyTrackId) =>
                      onDecision(item, "confirm_track", spotifyTrackId)
                    }
                  />
                  <button
                    className="primary-button"
                    disabled={pending}
                    onClick={() => onDecision(item, "confirm")}
                    type="button"
                  >
                    <Check size={15} /> {pending ? "Resolving..." : "Confirm candidate"}
                  </button>
                </div>
              </article>
            );
          })
        ) : reviewFilter !== "musicbrainz_mappings" &&
          reviewFilter !== "apple_music_mappings" &&
          mappingReviews.length === 0 ? (
          <div className="empty-state">
            <Check size={22} />
            <strong>No items need review.</strong>
            <span>Ambiguous future matches will appear here.</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ManualSpotifyTrackReviewAction({
  disabled,
  item,
  onConfirm,
}: {
  disabled: boolean;
  item: FeedFixtureItem;
  onConfirm: (spotifyTrackId: string) => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const confirm = () => {
    const match = value.trim().match(/(?:open\.spotify\.com\/track\/)?([A-Za-z0-9]{22})/);
    if (!match?.[1]) {
      setError("Enter a Spotify track link or 22-character track ID.");
      return;
    }
    setError(null);
    onConfirm(match[1]);
  };
  return (
    <div className="manual-track-review-action">
      <label>
        <span className="sr-only">Spotify track link for {item.title}</span>
        <input
          aria-label={`Spotify track link for ${item.title}`}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Spotify track link"
          value={value}
        />
      </label>
      <button className="secondary-button" disabled={disabled} onClick={confirm} type="button">
        Confirm track mapping
      </button>
      {error && <small className="form-error">{error}</small>}
    </div>
  );
}

function AppleMusicManualMappingForm({
  artistId,
  disabled,
  onSaved,
}: {
  artistId: string;
  disabled: boolean;
  onSaved: () => void;
}) {
  const [externalId, setExternalId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^\d{1,32}$/.test(externalId)) {
      setError("Enter the numeric Apple Music artist ID.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/apple-music/mappings/manual", {
        body: JSON.stringify({ artistId, externalId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error("Unable to save the Apple Music artist ID.");
      onSaved();
    } catch (submissionError) {
      setError(
        submissionError instanceof Error ? submissionError.message : "Unable to save mapping.",
      );
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <form className="inline-row-form" onSubmit={(event) => void submit(event)}>
      <label>
        <span className="sr-only">Apple Music artist ID</span>
        <input
          aria-label="Apple Music artist ID"
          disabled={disabled || submitting}
          inputMode="numeric"
          onChange={(event) => setExternalId(event.target.value.trim())}
          placeholder="Apple artist ID"
          value={externalId}
        />
      </label>
      <button className="primary-button" disabled={disabled || submitting} type="submit">
        {submitting ? "Saving" : "Confirm ID"}
      </button>
      {error && <span className="form-error">{error}</span>}
    </form>
  );
}

interface SettingsViewProps {
  dailyScan: boolean;
  digest: boolean;
  onDailyScanChange: (value: boolean) => void;
  onDigestChange: (value: boolean) => void;
  onImportConfirmed: (summary: ImportSummary) => Promise<void>;
  onNotice: (message: string) => void;
  onThemeChange: (value: ThemePreference) => void;
  providerConfiguration: ProviderUiConfiguration;
  themePreference: ThemePreference;
}

const systemStatusSchema = z.object({
  appleMusic: z.object({
    configured: z.boolean(),
    cooldownActive: z.boolean().optional(),
    cooldownUntil: z.string().nullable().optional(),
    enabled: z.boolean(),
    lastError: z.string().nullable().optional(),
    lastSuccessfulScanAt: z.string().nullable().optional(),
    leaseActive: z.boolean().optional(),
    mappingReviewCount: z.number().optional(),
    minRequestIntervalMs: z.number(),
    queueDepth: z.number().optional(),
    requestCount: z.number().optional(),
    storefront: z.string(),
  }),
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
  musicbrainz: z
    .object({
      configured: z.boolean(),
      enabled: z.boolean(),
      lastError: z.string().nullable().optional(),
      lastRateLimitWaitMs: z.number().nullable().optional(),
      lastSuccessfulScanAt: z.string().nullable().optional(),
      mappingReviewCount: z.number().optional(),
      userAgentConfigured: z.boolean(),
    })
    .optional(),
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
    automaticEnabled: z.boolean().default(false),
    expectedNextScanAt: z.string().nullable(),
    managedByApplication: z.boolean(),
    recommendedCommand: z.string(),
    schedule: z.string().nullable(),
  }),
  spotify: z.object({
    allowedPlaylistConfigured: z.boolean(),
    configured: z.boolean(),
    connected: z.boolean().optional(),
    enabled: z.boolean(),
    expectedPlaylistPublic: z.boolean(),
    followedArtistsImported: z.boolean().optional(),
    grantedScopes: z.array(z.string()).optional(),
    lastError: z.string().nullable().optional(),
    lastPlaylistSyncAt: z.string().nullable().optional(),
    lastSuccessfulRequestAt: z.string().nullable().optional(),
    lastSuccessfulScanAt: z.string().nullable().optional(),
    playlistConfigured: z.boolean().optional(),
    playlistWritesEnabled: z.boolean(),
    playlistWritePolicy: z.literal("authorized_owner_non_collaborative"),
    redirectUriValid: z.boolean(),
    requiredScopes: z.array(z.string()),
    scheduler: z.lazy(() => spotifySchedulerStatusSchema).optional(),
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
              ["Enabled", yesNo(status.appleMusic.enabled)],
              ["Configured", yesNo(status.appleMusic.configured)],
              ["Storefront", status.appleMusic.storefront.toUpperCase()],
              ["Request interval", `${status.appleMusic.minRequestIntervalMs} ms`],
              ["Last scan", formatStatusDate(status.appleMusic.lastSuccessfulScanAt)],
              ["Mapping reviews", String(status.appleMusic.mappingReviewCount ?? 0)],
              ["Requests", String(status.appleMusic.requestCount ?? 0)],
              [
                "Cooldown",
                status.appleMusic.cooldownActive
                  ? formatStatusDate(status.appleMusic.cooldownUntil)
                  : "None",
              ],
              ["Lease", status.appleMusic.leaseActive ? "Active" : "Idle"],
            ]}
            error={status.appleMusic.lastError}
            name="Apple Music"
            ready={status.appleMusic.enabled && status.appleMusic.configured}
            statusLabel={status.appleMusic.enabled ? undefined : "Optional provider disabled"}
          />
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
              ["Playlist writes", status.spotify.playlistWritesEnabled ? "Enabled" : "Disabled"],
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
          {status.musicbrainz && (
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
          )}
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
  onImportConfirmed,
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
          minRequestIntervalMs={providerConfiguration.spotify.minRequestIntervalMs}
          name="Spotify"
          onImportConfirmed={onImportConfirmed}
        />
        <SpotifySetupChecklist
          configured={providerConfiguration.spotify.configured}
          enabled={providerConfiguration.spotify.enabled}
        />
        <div className="setting-row">
          <div>
            <strong>Spotify playlist permission boundary</strong>
            <small>
              Spotify grants playlist permissions at the account scope level, not to one individual
              playlist. TS New Music Scanner additionally restricts itself to the configured
              playlist ID.
            </small>
          </div>
          <span className="status-chip">
            {providerConfiguration.spotify.playlistWritesEnabled
              ? "Writes enabled"
              : "Writes disabled"}
          </span>
        </div>
        {providerConfiguration.musicbrainz.enabled && (
          <ProviderSetting
            configured={providerConfiguration.musicbrainz.configured}
            enabled={providerConfiguration.musicbrainz.enabled}
            name="MusicBrainz"
          />
        )}
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

const scanHistoryEntrySchema = z.object({
  artistCount: z.number().int().nonnegative().nullable(),
  artistFilter: z.string().nullable(),
  batchId: z.string().uuid().nullable(),
  batchMode: z.string().nullable(),
  completedAt: z.string().datetime().nullable(),
  createdCount: z.number().int().nonnegative(),
  dryRun: z.boolean(),
  failureCount: z.number().int().nonnegative().nullable(),
  id: z.string().uuid(),
  partialArtistCount: z.number().int().nonnegative().nullable(),
  provider: z.string().nullable(),
  providersRequested: z.array(z.string()),
  requestCount: z.number().int().nonnegative().nullable(),
  reviewCount: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  status: z.string(),
  triggerType: z.string(),
  updatedCount: z.number().int().nonnegative(),
});

const scanHistorySchema = z.object({
  history: z.array(scanHistoryEntrySchema),
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
  minRequestIntervalMs,
  name,
  onImportConfirmed,
}: {
  configured: boolean;
  enabled: boolean;
  minRequestIntervalMs?: number;
  name: "Spotify" | "MusicBrainz";
  onImportConfirmed?: (summary: ImportSummary) => Promise<void>;
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
      setError(null);
      await onImportConfirmed?.(summary);
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
  const clearInvalidCooldown = async () => {
    const reason = window.prompt(
      "Describe the verified local parsing defect. This does not remove a Spotify-imposed limit.",
    );
    if (!reason || reason.trim().length < 20) {
      setError("A specific correction reason of at least 20 characters is required.");
      return;
    }
    if (
      !window.confirm(
        "Clear only the locally calculated cooldown? This does not mean Spotify removed its rate limit.",
      )
    ) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/spotify/cooldown", {
        body: JSON.stringify({ confirmation: "CLEAR INVALID LOCAL COOLDOWN", reason }),
        headers: { "Content-Type": "application/json" },
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Cooldown correction was rejected.");
      setSpotifyStatus((current) =>
        current?.operational
          ? {
              ...current,
              operational: {
                ...current.operational,
                canManualClear: false,
                cooldownActive: false,
                cooldownIndefinite: false,
                cooldownUntil: null,
              },
            }
          : current,
      );
    } catch {
      setError("The local cooldown could not be corrected.");
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
            ? "Server-side OAuth, followed-artist import, catalog discovery, and guarded configured-playlist inspection."
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
          {spotifyStatus.operational?.cooldownActive && (
            <small role="status">
              Spotify cooldown:{" "}
              {spotifyStatus.operational.cooldownIndefinite
                ? "manual review required"
                : `until ${new Date(spotifyStatus.operational.cooldownUntil!).toLocaleString()}`}
            </small>
          )}
          <small>
            Request interval: {(minRequestIntervalMs ?? 10_000) / 1_000}s | Queue:{" "}
            {spotifyStatus.operational?.queueDepth ?? 0}
          </small>
          {spotifyStatus.operational?.canManualClear && (
            <button
              className="secondary-button"
              disabled={submitting}
              onClick={() => void clearInvalidCooldown()}
              type="button"
            >
              Correct invalid local cooldown
            </button>
          )}
          <button
            className="secondary-button"
            disabled={submitting || spotifyStatus.operational?.cooldownActive}
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
    ["Allowed playlist ID configured", status?.spotify.allowedPlaylistConfigured ?? false],
    ["Production playlist expected public", status?.spotify.expectedPlaylistPublic ?? false],
    ["Playlist writes enabled", status?.spotify.playlistWritesEnabled ?? false],
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
      <div className="setup-scopes" aria-label="Currently granted Spotify scopes">
        <strong>Currently granted scopes</strong>
        <small>{status?.spotify.grantedScopes?.join(", ") || "None granted"}</small>
      </div>
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

const musicBrainzMappingsResponseSchema = z.object({
  mappings: z.array(
    z.object({
      artistId: z.string().uuid().default("00000000-0000-4000-8000-000000000000"),
      artistName: z.string(),
      confidence: z.string().nullable(),
      externalId: z.string().uuid(),
      reasons: z.array(z.string()),
      url: z.string().url(),
    }),
  ),
  reviews: z.array(
    z.object({
      id: z.string().uuid(),
      proposedExternalId: z.string().uuid(),
      status: z.string(),
    }),
  ),
});

const mappingReviewPageSchema = z.object({
  hasMore: z.boolean().default(false),
  nextCursor: z.string().nullable().default(null),
  summary: z
    .object({
      pendingCandidates: z.number().int().nonnegative(),
      unresolvedArtists: z.number().int().nonnegative(),
    })
    .optional(),
  reviews: z.array(
    z.object({
      artistId: z.string().uuid(),
      artistName: z.string(),
      candidateEvidence: z
        .object({
          activityDate: z.string().nullable(),
          appleArtistName: z.string(),
          artistUrl: z.string().url().nullable(),
          artworkUrl: z.string().url().nullable(),
          autoConfirmEligible: z.boolean(),
          collaborators: z.array(z.string()),
          contradictions: z.array(z.string()),
          eliminationSafe: z.boolean(),
          exactLinkSource: z.string().nullable(),
          genres: z.array(z.string()),
          labels: z.array(z.string()),
          rank: z.number().int().positive(),
          rankingReasons: z.array(z.string()),
          resourceStatus: z.string(),
          score: z.string(),
          source: z.string(),
          titleOverlaps: z.array(
            z.object({
              distinctive: z.boolean(),
              leftTitle: z.string(),
              rightTitle: z.string(),
              weight: z.number(),
            }),
          ),
          topReleases: z.array(
            z.object({
              artworkUrl: z.string().url().optional(),
              releaseDate: z.string().optional(),
              title: z.string(),
            }),
          ),
          topSongs: z.array(
            z.object({
              artworkUrl: z.string().url().optional(),
              releaseDate: z.string().optional(),
              title: z.string(),
            }),
          ),
        })
        .optional(),
      confirmedEvidence: z
        .array(
          z.object({
            externalId: z.string(),
            mappingSource: z.string(),
            provider: z.enum(["apple_music", "musicbrainz", "spotify"]),
            url: z.string().url().nullable(),
          }),
        )
        .default([]),
      confidence: z.string(),
      id: z.string().uuid(),
      name: z.string(),
      proposedExternalId: z.string().nullable(),
      provider: z.enum(["apple_music", "musicbrainz"]).default("musicbrainz"),
      reasons: z.array(z.string()),
      status: z.string(),
    }),
  ),
});

const feedItemResponseSchema = z.object({
  accent: z.enum(["coral", "cyan", "lime", "gold"]),
  artist: z.string(),
  confidence: z.number().min(0).max(1),
  discNumber: z.number().int().positive().optional(),
  exportStatus: z.enum(["eligible", "exported", "blocked", "review_required"]),
  firstSeenAt: z.string().datetime(),
  id: z.string(),
  links: z.array(z.object({ href: z.string().url(), label: z.string() })),
  listened: z.boolean(),
  matchReason: z.string(),
  providerOrder: z.number().int().positive().optional(),
  reddit: z
    .object({
      artistMatchConfidence: z.number(),
      corroboration: z.enum(["reddit_only", "spotify", "musicbrainz", "user_confirmed"]),
      directSpotifyLink: z.boolean(),
      parseConfidence: z.number(),
      postCreatedAt: z.string(),
      sourceDeleted: z.boolean(),
      subreddit: z.string(),
      unverifiedExternalLink: z.boolean(),
    })
    .optional(),
  region: z.string(),
  releaseDate: z.string(),
  releaseGroupDate: z.string().optional(),
  releaseDatePrecision: z.enum(["day", "month", "year"]).optional(),
  releaseCompleteness: z
    .object({
      expectedTracks: z.number().int().nonnegative(),
      fetchedTracks: z.number().int().nonnegative(),
      missingTracks: z.number().int().nonnegative(),
      status: z.enum([
        "not_started",
        "in_progress",
        "partial",
        "completed",
        "paused",
        "rate_limited",
        "failed",
      ]),
    })
    .optional(),
  releaseId: z.string().optional(),
  releaseTitle: z.string(),
  releaseType: z.enum(releaseTypes),
  review: z
    .object({
      candidateId: z.string().uuid(),
      deferredUntil: z.string().datetime().optional(),
      provider: z.enum([
        "mock",
        "spotify",
        "musicbrainz",
        "reddit",
        "youtube",
        "soundcloud",
        "apple_music",
        "tidal",
      ]),
      providerUrl: z.string().url().optional(),
    })
    .optional(),
  saved: z.boolean(),
  soundcloudState: z.enum(soundCloudLinkStates),
  sources: z.array(
    z.object({ evidenceHref: z.string().url(), href: z.string().url(), provider: z.string() }),
  ),
  spotify: z.enum(["playable", "preview", "blocked", "unavailable"]),
  spotifyArtwork: z
    .object({
      albumId: z.string().min(1),
      albumUrl: z.string(),
      image: z.object({
        height: z.number().int().positive().nullable(),
        url: z.string().refine((value) => normalizeSpotifyArtworkUrl(value) !== null),
        width: z.number().int().positive().nullable(),
      }),
      lastObservedAt: z.string().datetime(),
      sourceProvider: z.literal("spotify"),
    })
    .superRefine((value, context) => {
      if (normalizeSpotifyAlbumUrl(value.albumUrl, value.albumId) === null) {
        context.addIssue({ code: "custom", message: "Invalid Spotify album URL" });
      }
    })
    .optional(),
  appleMusicArtwork: z
    .object({
      albumId: z.string().min(1),
      albumUrl: z.string(),
      image: z.object({
        height: z.number().int().positive(),
        url: z.string().refine((value) => normalizeAppleMusicArtworkUrl(value) !== null),
        width: z.number().int().positive(),
      }),
      lastObservedAt: z.string().datetime(),
      sourceProvider: z.literal("apple_music"),
    })
    .superRefine((value, context) => {
      if (normalizeAppleMusicAlbumUrl(value.albumUrl, value.albumId) === null) {
        context.addIssue({ code: "custom", message: "Invalid Apple Music album URL" });
      }
    })
    .optional(),
  state: z.enum(feedStates),
  title: z.string(),
  trackNumber: z.number().int().positive().optional(),
});

const feedRevisionResponseSchema = z.object({
  count: z.number().int().nonnegative(),
  revision: z.string().min(1),
});

const feedSnapshotResponseSchema = feedRevisionResponseSchema.extend({
  hasMore: z.boolean().default(false),
  items: z.array(feedItemResponseSchema),
  nextCursor: z.string().nullable().default(null),
  summary: z
    .object({
      needsReview: z.number().int().nonnegative(),
      newThisWeek: z.number().int().nonnegative(),
      upcoming: z.number().int().nonnegative(),
    })
    .default({ needsReview: 0, newThisWeek: 0, upcoming: 0 }),
  totalCount: z.number().int().nonnegative().default(0),
});

const spotifyStatusSchema = z.object({
  batch: z.lazy(() => spotifyBatchSchema).optional(),
  displayName: z.string().nullable().optional(),
  lastTokenRefreshAt: z.string().nullable().optional(),
  operational: z.lazy(() => spotifyOperationalSchema).optional(),
  scheduler: z.lazy(() => spotifySchedulerStatusSchema).optional(),
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
  alreadyPresent: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  merged: z.number().int().nonnegative(),
  needsReview: z.number().int().nonnegative(),
  persisted: z.number().int().nonnegative(),
  retrieved: z.number().int().nonnegative(),
  selected: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

const scanRunStatusSchema = z.object({
  completedAt: z.string().datetime().nullable(),
  id: z.string().uuid(),
  insertedCount: z.number().int().nonnegative(),
  provider: z.string().nullable(),
  providersCompleted: z.array(z.string()),
  providersFailed: z.array(z.string()),
  providersRequested: z.array(z.string()),
  startedAt: z.string().datetime(),
  status: z.enum([
    "running",
    "completed",
    "partial",
    "failed",
    "cancelled",
    "paused",
    "rate_limited",
  ]),
});

const spotifyOperationalSchema = z.object({
  canManualClear: z.boolean(),
  cooldownActive: z.boolean(),
  cooldownEndpointCategory: z.string().nullable(),
  cooldownErrorClassification: z.string().nullable(),
  cooldownIndefinite: z.boolean(),
  cooldownObservedAt: z.string().datetime().nullable(),
  cooldownUntil: z.string().datetime().nullable(),
  lastRequestStartedAt: z.string().datetime().nullable(),
  nextRequestAt: z.string().datetime().nullable(),
  parsedRetryAfterSeconds: z.string().nullable(),
  queueDepth: z.number().int().nonnegative(),
  rawRetryAfter: z.string().nullable(),
  requestCount: z.number().int().nonnegative(),
});

const spotifyArtistScanSchema = z.object({
  artistId: z.string().uuid(),
  errorClassification: z.string().nullable(),
  id: z.string().uuid(),
  position: z.number().int().nonnegative(),
  status: z.string(),
});

const spotifyBatchSchema = z
  .object({
    artistScans: z.array(spotifyArtistScanSchema),
    blockedMappingArtists: z.number().int().nonnegative(),
    cancelledArtists: z.number().int().nonnegative(),
    completedArtists: z.number().int().nonnegative(),
    confirmationRequired: z.boolean(),
    estimatedRequests: z.number().int().nonnegative(),
    failedArtists: z.number().int().nonnegative(),
    id: z.string().uuid(),
    mode: z.string(),
    pageLimit: z.number().int().positive(),
    partialArtists: z.number().int().nonnegative(),
    rateLimitedArtists: z.number().int().nonnegative(),
    status: z.string(),
    totalArtists: z.number().int().nonnegative(),
  })
  .nullable();

const spotifySchedulerStatusSchema = z.object({
  activeLease: z
    .object({
      artistId: z.string().uuid().nullable(),
      expiresAt: z.string().datetime(),
      workId: z.string().uuid(),
      workType: z.enum([
        "base_artist",
        "release_detail",
        "release_tracks",
        "artist_reconciliation",
      ]),
    })
    .nullable(),
  artistsCheckedLast24Hours: z.number().int().nonnegative(),
  artistsCheckedLastHour: z.number().int().nonnegative(),
  appleCatchupPriorityCount: z.number().int().nonnegative(),
  applePriorityCount: z.number().int().nonnegative(),
  backlog: z.object({
    artist_reconciliation: z.number().int().nonnegative(),
    base_artist: z.number().int().nonnegative(),
    release_detail: z.number().int().nonnegative(),
    release_tracks: z.number().int().nonnegative(),
  }),
  blockedCount: z.number().int().nonnegative(),
  blockedReasons: z.array(z.string()),
  cooldownActive: z.boolean(),
  cooldownUntil: z.string().datetime().nullable(),
  dailyBudget: z.object({
    broadArtistsLimit: z.number().int().positive(),
    broadArtistsUsed: z.number().int().nonnegative(),
    broadRequestsLimit: z.number().int().positive(),
    broadRequestsUsed: z.number().int().nonnegative(),
    localDate: z.iso.date(),
    playlistRequestReserve: z.number().int().positive(),
    priorityRequestReserve: z.number().int().positive(),
  }),
  dueArtistCount: z.number().int().nonnegative(),
  eligibleArtistCount: z.number().int().nonnegative(),
  estimatedCompletion: z.object({
    earliest: z.string().datetime().nullable(),
    latest: z.string().datetime().nullable(),
    state: z.enum(["available", "blocked"]),
  }),
  endpointBudget: z.object({
    artistAlbums: z.object({
      allowance: z.number().int().positive(),
      broadAllowance: z.number().int().nonnegative(),
      broadRemaining: z.number().int().nonnegative(),
      broadUsed: z.number().int().nonnegative(),
      calls: z.number().int().nonnegative(),
      nextCapacityAt: z.string().datetime().nullable(),
      priorityRemaining: z.number().int().nonnegative(),
      priorityReserve: z.number().int().nonnegative(),
      priorityUsed: z.number().int().nonnegative(),
      remaining: z.number().int().nonnegative(),
      reserveRemaining: z.number().int().nonnegative(),
      reserveReleased: z.boolean(),
    }),
    playlist: z.object({
      reads: z.number().int().nonnegative(),
      writes: z.number().int().nonnegative(),
    }),
  }),
  http429Last24Hours: z.number().int().nonnegative(),
  lastQuotaExceeded: z
    .object({
      cooldownUntil: z.string().datetime().nullable(),
      endpointCategory: z.string(),
      observedAt: z.string().datetime(),
    })
    .nullable(),
  mode: z.enum(["disabled", "planning", "validation", "automatic", "paused"]),
  nextBaseSlotAt: z.string().datetime().nullable(),
  oldestOverdueAgeMs: z.number().nonnegative().nullable(),
  overdueArtistCount: z.number().int().nonnegative(),
  partialArtistCount: z.number().int().nonnegative(),
  requestCounts: z.object({
    byEndpointCategory: z.object({
      album_detail: z.number().int().nonnegative(),
      album_tracks: z.number().int().nonnegative(),
      artist_albums: z.number().int().nonnegative(),
      oauth_or_other: z.number().int().nonnegative(),
      playlist_read: z.number().int().nonnegative(),
      playlist_write: z.number().int().nonnegative(),
    }),
    byWorkType: z
      .object({
        artist_reconciliation: z.number().int().nonnegative().optional(),
        base_artist: z.number().int().nonnegative().optional(),
        release_detail: z.number().int().nonnegative().optional(),
        release_tracks: z.number().int().nonnegative().optional(),
      })
      .default({}),
    last24Hours: z.number().int().nonnegative(),
    last30Minutes: z.number().int().nonnegative(),
  }),
  recentWork: z
    .object({
      artistId: z.string().uuid().nullable(),
      completedAt: z.string().datetime(),
      workId: z.string().uuid(),
      workType: z.enum([
        "base_artist",
        "release_detail",
        "release_tracks",
        "artist_reconciliation",
      ]),
    })
    .nullable(),
  targetArtistCount: z.number().int().nonnegative(),
});

const discoveryScheduleJobSchema = z.object({
  appleMusicBatchId: z.string().uuid().nullable(),
  batchCompletedArtists: z.number().int().nonnegative().nullable(),
  batchFailedArtists: z.number().int().nonnegative().nullable(),
  batchTotalArtists: z.number().int().nonnegative().nullable(),
  completedAt: z.string().datetime().nullable(),
  errorClassification: z.string().nullable(),
  jobType: z.enum(["apple_full", "apple_catchup"]),
  recoveryDeadline: z.string().datetime(),
  scheduledFor: z.string().datetime(),
  status: z.enum(["scheduled", "leased", "completed", "failed", "expired"]),
});

const discoveryScheduleStatusSchema = z.object({
  catchup: z.object({
    latest: discoveryScheduleJobSchema.nullable(),
    next: discoveryScheduleJobSchema.nullable(),
  }),
  full: z.object({
    latest: discoveryScheduleJobSchema.nullable(),
    next: discoveryScheduleJobSchema.nullable(),
  }),
  phase: z.enum([
    "idle",
    "cooldown_wait",
    "playlist_inbox",
    "apple_priority",
    "apple_catchup_priority",
    "broad_spotify",
    "weekly_apple",
  ]),
  playlistInbox: z.object({
    exportRunId: z.string().uuid().nullable(),
    pendingCount: z.number().int().nonnegative(),
    status: z.enum(["pending", "ready", "exporting", "partial", "completed", "failed"]),
  }),
  timezone: z.literal("America/Los_Angeles"),
});

const scanStatusSchema = z.object({
  active: z
    .object({
      currentProvider: z.string().nullable(),
      cancelRequested: z.boolean(),
      completedUnits: z.number().int().nonnegative(),
      currentUnit: z.string().nullable(),
      currentStage: z.string().nullable().default(null),
      expiresAt: z.string().datetime(),
      heartbeatAt: z.string().datetime().nullable(),
      lastPersistedResult: z.string().nullable().default(null),
      phase: z.string().nullable(),
      providersCompleted: z.array(z.string()),
      providersFailed: z.array(z.string()),
      providersRequested: z.array(z.string()),
      rateLimitWaitMs: z.number().nonnegative(),
      requests: z.number().int().nonnegative(),
      retryAfterMs: z.number().nonnegative(),
      startedAt: z.string().datetime(),
      totalUnits: z.number().int().nonnegative(),
    })
    .nullable(),
  defaultHistoryId: z.string().uuid().nullable(),
  discoverySchedule: discoveryScheduleStatusSchema,
  history: z.array(scanHistoryEntrySchema),
  historyHasMore: z.boolean().default(false),
  historyNextCursor: z.string().nullable().default(null),
  latest: scanRunStatusSchema.nullable(),
  musicbrainz: z
    .object({
      batch: z
        .object({
          cancelledArtists: z.number().int().nonnegative(),
          completedArtists: z.number().int().nonnegative(),
          failedArtists: z.number().int().nonnegative(),
          id: z.string().uuid(),
          status: z.string(),
          totalArtists: z.number().int().nonnegative(),
        })
        .passthrough()
        .nullable(),
      operational: z.object({
        lastRequestStartedAt: z.string().datetime().nullable(),
        nextRequestAt: z.string().datetime().nullable(),
        queueDepth: z.number().int().nonnegative(),
        requestCount: z.number().int().nonnegative(),
      }),
    })
    .default({
      batch: null,
      operational: {
        lastRequestStartedAt: null,
        nextRequestAt: null,
        queueDepth: 0,
        requestCount: 0,
      },
    }),
  running: z.boolean(),
  runs: z.array(scanRunStatusSchema),
  spotify: z.object({
    batch: spotifyBatchSchema,
    coverage: z.object({
      currentCycleCompletedPages: z.number().int().nonnegative(),
      estimatedRemainingPages: z.number().int().nonnegative(),
      estimatedRemainingRequests: z.number().int().nonnegative(),
      failedArtists: z.number().int().nonnegative(),
      fullyReconciledArtists: z.number().int().nonnegative(),
      inProgressArtists: z.number().int().nonnegative(),
      partialArtists: z.number().int().nonnegative(),
      pausedArtists: z.number().int().nonnegative(),
      queuedArtists: z.number().int().nonnegative(),
      rateLimitedArtists: z.number().int().nonnegative(),
      totalArtists: z.number().int().nonnegative(),
    }),
    limiter: z.object({
      artistsPerBatch: z.number().int().positive(),
      batchPauseSeconds: z.number().int().nonnegative(),
      distributionHours: z.number().positive(),
      maxRequestsPerRun: z.number().int().positive(),
      minRequestIntervalMs: z.number().int().positive(),
      reconciliationArtistsPerBatch: z.number().int().positive(),
      reconciliationCycleDays: z.number().int().positive(),
      reconciliationMaxPagesPerRun: z.number().int().positive(),
    }),
    operational: spotifyOperationalSchema,
    scheduler: spotifySchedulerStatusSchema.optional(),
  }),
});

const scanLaunchSchema = z.object({
  accepted: z.boolean(),
});

const feedPreferenceResponseSchema = z.object({
  item: z.object({
    id: z.string().uuid(),
    listened: z.boolean(),
    saved: z.boolean(),
    state: z.enum(["new", "upcoming", "saved", "dismissed", "listened", "needs_review"]),
  }),
});

const reviewResolutionResponseSchema = z.object({
  resolution: z.object({
    decision: z.enum(["confirm", "confirm_track", "defer", "no_equivalent", "retry", "separate"]),
    deferredUntil: z.coerce.date().optional(),
    feedItemId: z.string().uuid(),
    removed: z.boolean(),
    state: z.enum(["needs_review", "new"]),
  }),
});

const releaseReviewQueueStatusResponseSchema = z.object({
  status: z.object({
    actionableCount: z.number().int().nonnegative(),
    blockedExport: z.object({
      stale: z.number().int().nonnegative(),
      systemWaiting: z.number().int().nonnegative(),
      terminal: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      userActionable: z.number().int().nonnegative(),
    }),
    deferredCount: z.number().int().nonnegative(),
    staleCount: z.number().int().nonnegative(),
    systemWaiting: z.array(
      z.object({
        attemptCount: z.number().int().nonnegative(),
        dueAt: z.string().datetime(),
        id: z.string().uuid(),
        notBefore: z.string().datetime().nullable(),
        reason: z.string(),
        releaseTitle: z.string(),
        source: z.string(),
        status: z.string(),
        title: z.string(),
        trackId: z.string().uuid(),
      }),
    ),
    systemWaitingCount: z.number().int().nonnegative(),
    terminalCount: z.number().int().nonnegative(),
  }),
});

const watchlistResponseSchema = z.object({
  activeCount: z.number().int().nonnegative(),
  artists: z.array(
    z.object({
      active: z.boolean(),
      addedAt: z.string().datetime(),
      id: z.string().uuid(),
      name: z.string().min(1),
      providers: z.array(z.string()),
      source: z.string(),
      spotifyCoverage: z
        .object({
          catalogPagesCompleted: z.number().int().nonnegative(),
          dailyScanCompletedAt: z.string().datetime().nullable(),
          lastFullReconciliationAt: z.string().datetime().nullable(),
          nextOffset: z.number().int().nonnegative(),
          pagesScannedInCycle: z.number().int().nonnegative(),
          partial: z.boolean(),
          status: z.string(),
        })
        .nullable(),
    }),
  ),
});

function formatScanTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function spotifyCoverageLabel(coverage: WatchedArtist["spotifyCoverage"]): string {
  if (!coverage) return "Reconciliation queued";
  if (coverage.status === "fully_reconciled") return "Fully reconciled";
  if (coverage.status === "reconciliation_in_progress") return "Reconciling catalog";
  if (coverage.status === "rate_limited") return "Rate limited";
  if (coverage.status === "failed") return "Reconciliation failed";
  if (coverage.status === "paused") return "Reconciliation paused";
  if (coverage.partial) return "Partial catalog";
  return "Daily scan current";
}

function spotifyCoverageDetail(coverage: WatchedArtist["spotifyCoverage"]): string {
  if (!coverage) return "No catalog pages have been reconciled yet.";
  const fullDate = coverage.lastFullReconciliationAt
    ? new Date(coverage.lastFullReconciliationAt).toLocaleDateString()
    : "never";
  return `${coverage.pagesScannedInCycle} pages scanned in this cycle; next offset ${coverage.nextOffset}; last fully reconciled ${fullDate}.`;
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${hours < 10 ? hours.toFixed(1) : Math.ceil(hours)} hr`;
}

function formatKnownCount(value: number | null): string {
  return value === null ? "Unavailable" : String(value);
}

function formatScanHistoryDuration(run: ScanHistoryEntry): string {
  if (!run.completedAt) return "Unavailable";
  const milliseconds = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "Unavailable";
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes} min ${remainingSeconds} sec`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr ${minutes % 60} min`;
}

function scanHistoryProviderLabel(run: ScanHistoryEntry): string {
  const providers = run.provider ? [run.provider] : run.providersRequested;
  return providers.length > 0
    ? providers.map((provider) => titleCase(provider)).join(", ")
    : "Unavailable";
}

function scanHistoryRunLabel(run: ScanHistoryEntry): string {
  const kind =
    run.artistCount === 1
      ? "single-artist scan"
      : run.artistCount && run.artistCount > 1
        ? `${run.artistCount}-artist batch`
        : "provider scan";
  return `${scanHistoryProviderLabel(run)} ${kind}${run.dryRun ? " | dry run" : ""}`;
}

function scanHistoryOptionLabel(run: ScanHistoryEntry): string {
  return `${scanHistoryRunLabel(run)} | ${titleCase(run.status)} | ${new Date(
    run.startedAt,
  ).toLocaleString()}`;
}

function scanRunLabel(run: ScanRunStatus): string {
  const providers = run.providersCompleted.length
    ? run.providersCompleted
    : run.providersRequested.length
      ? run.providersRequested
      : run.provider
        ? [run.provider]
        : [];
  const providerLabel = providers.length
    ? providers.map((provider) => titleCase(provider)).join(", ")
    : "Provider scan";
  if (run.status === "failed") return `${providerLabel} | failed`;
  if (run.status === "partial") return `${providerLabel} | completed with warnings`;
  return `${providerLabel} | ${run.insertedCount} added`;
}

function mergeFeedItems(
  currentItems: FeedFixtureItem[],
  refreshedItems: FeedFixtureItem[],
): FeedFixtureItem[] {
  const merged = [...currentItems];
  const indexById = new Map(currentItems.map((item, index) => [item.id, index]));
  for (const item of refreshedItems) {
    const existingIndex = indexById.get(item.id);
    if (existingIndex === undefined) {
      indexById.set(item.id, merged.length);
      merged.push(item);
    } else {
      merged[existingIndex] = { ...merged[existingIndex], ...item };
    }
  }
  return merged;
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()];
}

function FeedItem({
  item,
  onItemChange,
  onTogglePreference,
  pendingFeedActions,
  onSoundCloudLinkChange,
  soundCloudManualLinksEnabled,
  soundCloudLink,
  showArtwork = true,
}: {
  item: FeedFixtureItem;
  onItemChange: (id: string, changes: Partial<FeedFixtureItem>, message: string) => void;
  onTogglePreference: (item: FeedFixtureItem, preference: FeedPreference) => void;
  pendingFeedActions: string[];
  onSoundCloudLinkChange: (feedItemId: string, record?: SoundCloudLinkRecord) => void;
  soundCloudManualLinksEnabled: boolean;
  soundCloudLink: SoundCloudLinkRecord | undefined;
  showArtwork?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const stateLabel = item.state === "needs_review" ? "Needs review" : titleCase(item.state);
  const savePending = pendingFeedActions.includes(`${item.id}:saved`);
  const listenedPending = pendingFeedActions.includes(`${item.id}:listened`);
  const streamingSources = getStreamingSourceTags(item, soundCloudLink);
  return (
    <article
      className={`feed-item ${showArtwork ? "" : "without-cover"} ${collapsed ? "is-collapsed" : ""}`}
      data-feed-anchor={item.id}
    >
      {showArtwork && <FeedArtwork item={item} />}

      <div className="item-main">
        <div className="item-title-row">
          <div className="item-title-copy">
            <button
              aria-expanded={!collapsed}
              aria-label={`${collapsed ? "Expand" : "Collapse"} ${item.title}`}
              className="feed-item-disclosure"
              onClick={() => setCollapsed((current) => !current)}
              title={`${collapsed ? "Expand" : "Collapse"} release details`}
              type="button"
            >
              {collapsed ? <ChevronRight size={17} /> : <ChevronDown size={17} />}
            </button>
            <div className="item-heading">
              <div className="badges">
                {item.state !== "new" && (
                  <span className={`state state-${item.state}`}>{stateLabel}</span>
                )}
                {item.saved && item.state !== "saved" && <span className="state-saved">Saved</span>}
                {item.listened && item.state !== "listened" && (
                  <span className="state-listened">Listened</span>
                )}
                <span>{titleCase(item.releaseType)}</span>
                {streamingSources.map((source) => (
                  <span
                    className={`streaming-source streaming-source-${source.id}`}
                    key={source.id}
                    title={`${source.label} source evidence is available`}
                  >
                    {source.label}
                  </span>
                ))}
              </div>
              <div className="item-heading-line">
                <h2>
                  {item.artist} - {item.title}
                </h2>
                <span className="item-title-date">
                  | {formatReleaseTitleDate(item.releaseDate, item.releaseDatePrecision)}
                </span>
              </div>
            </div>
          </div>
          <div className="item-actions">
            <button
              aria-label={item.saved ? `Unsave ${item.title}` : `Save ${item.title}`}
              aria-pressed={item.saved}
              className={`icon-button small preference-toggle ${item.saved ? "active" : ""}`}
              disabled={savePending}
              title={item.saved ? "Unsave" : "Save"}
              onClick={() => onTogglePreference(item, "saved")}
            >
              <Bookmark fill={item.saved ? "currentColor" : "none"} size={16} />
            </button>
            <button
              aria-label={
                item.listened ? `Mark ${item.title} unlistened` : `Mark ${item.title} listened`
              }
              aria-pressed={item.listened}
              className={`icon-button small preference-toggle ${item.listened ? "active" : ""}`}
              disabled={listenedPending}
              title={item.listened ? "Mark unlistened" : "Mark listened"}
              onClick={() => onTogglePreference(item, "listened")}
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
          <span>First seen {formatTimestamp(item.firstSeenAt)}</span>
          <span>{item.region}</span>
        </div>

        <div className="evidence-row">
          <div className="source-stack">
            {item.sources.map((source) => (
              <a
                href={source.href}
                key={`${source.provider}:${source.href}`}
                rel="noopener noreferrer"
                target="_blank"
              >
                {source.provider}
                <ExternalLink size={12} />
              </a>
            ))}
          </div>
          {soundCloudManualLinksEnabled && (
            <span className="availability availability-unavailable">
              SoundCloud {soundCloudStateLabel(soundCloudLink?.state ?? item.soundcloudState)}
            </span>
          )}
          {item.links[0] ? (
            <a
              className="feed-evidence-link"
              href={item.links[0].href}
              rel="noopener noreferrer"
              target="_blank"
            >
              Evidence <ChevronRight size={13} />
            </a>
          ) : (
            <span className="feed-evidence-link is-unavailable">Evidence unavailable</span>
          )}
        </div>

        {soundCloudManualLinksEnabled && (
          <SoundCloudReleaseControls
            item={item}
            onChange={onSoundCloudLinkChange}
            record={soundCloudLink}
          />
        )}
        {!hasSpotifyMatch(item) &&
          item.sources.some((source) => source.provider === "Apple Music") && (
            <SpotifyResolutionControls item={item} />
          )}
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

function SpotifyResolutionControls({ item }: { item: FeedFixtureItem }) {
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "queued" | "verifying">(
    item.spotifyResolution?.status === "queued" || item.spotifyResolution?.status === "verifying"
      ? item.spotifyResolution.status
      : "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const automaticResolution = item.spotifyResolution?.mode === "automatic";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus("submitting");
    setError(null);
    try {
      const response = await fetch(`/api/feed-items/${encodeURIComponent(item.id)}/spotify-link`, {
        body: JSON.stringify({ url }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Spotify verification could not be queued.");
      setStatus("queued");
      setEditing(false);
    } catch (submissionError) {
      setStatus("idle");
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "Spotify verification could not be queued.",
      );
    }
  };

  return (
    <div className="soundcloud-controls spotify-resolution-controls">
      <div className="soundcloud-actions">
        {status === "queued" || status === "verifying" ? (
          <span className="success-text">
            {status === "verifying"
              ? automaticResolution
                ? "Spotify match is being verified"
                : "Spotify link is being verified"
              : automaticResolution
                ? "Spotify match queued for exact verification"
                : "Spotify link queued for exact verification"}
          </span>
        ) : (
          <button
            aria-expanded={editing}
            className="text-button"
            onClick={() => {
              setEditing((current) => !current);
              setError(null);
            }}
            type="button"
          >
            <Link2 size={13} /> Paste exact Spotify track URL
          </button>
        )}
      </div>
      {item.spotifyResolution?.status === "mismatch" && !editing && (
        <span className="form-error">
          The last Spotify URL did not match this track&apos;s ISRC and artist.
        </span>
      )}
      {editing && (
        <form className="soundcloud-link-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor={`spotify-resolution-${item.id}`}>Exact Spotify track URL</label>
          <input
            id={`spotify-resolution-${item.id}`}
            onChange={(event) => {
              setUrl(event.target.value);
              setError(null);
            }}
            placeholder="https://open.spotify.com/track/..."
            value={url}
          />
          <button className="primary-button" disabled={status === "submitting"} type="submit">
            {status === "submitting" ? "Queuing..." : "Verify and link"}
          </button>
          <button
            className="secondary-button"
            disabled={status === "submitting"}
            onClick={() => setEditing(false)}
            type="button"
          >
            Cancel
          </button>
          {error && <span className="form-error">{error}</span>}
          <small>The scheduler verifies ISRC and artist before saving the match.</small>
        </form>
      )}
    </div>
  );
}

function FeedArtwork({ compact = false, item }: { compact?: boolean; item: FeedFixtureItem }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const artwork = item.spotifyArtwork ?? item.appleMusicArtwork;
  if (artwork && failedUrl !== artwork.image.url) {
    const providerName = artwork.sourceProvider === "spotify" ? "Spotify" : "Apple Music";
    const providerClass =
      artwork.sourceProvider === "spotify"
        ? compact
          ? "spotify-group-artwork"
          : "spotify-artwork-cover"
        : compact
          ? "apple-music-group-artwork"
          : "apple-music-artwork-cover";
    return (
      <a
        aria-label={`Open ${item.releaseTitle} by ${item.artist} on ${providerName}`}
        className={`${compact ? "release-feed-group-icon provider-group-artwork" : "cover provider-artwork-cover"} ${providerClass}`}
        href={artwork.albumUrl}
        rel="noopener noreferrer"
        target="_blank"
      >
        {/* Provider artwork loads directly from its allowlisted host without image optimization. */}
        <img
          alt={`Album artwork for ${item.releaseTitle} by ${item.artist}`}
          height={artwork.image.height ?? 300}
          loading="lazy"
          onError={() => setFailedUrl(artwork.image.url)}
          src={artwork.image.url}
          width={artwork.image.width ?? 300}
        />
      </a>
    );
  }
  if (compact) {
    return (
      <div className="release-feed-group-icon" aria-hidden="true">
        <Disc3 size={20} />
      </div>
    );
  }
  return (
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
  );
}

function groupFeedItems(items: FeedFixtureItem[], splitFutureReleases = false) {
  const groups = new Map<
    string,
    {
      artist: string;
      items: FeedFixtureItem[];
      key: string;
      releaseDate: string;
      releaseTitle: string;
      releaseType: FeedFixtureItem["releaseType"];
    }
  >();
  const today = new Date().toISOString().slice(0, 10);
  for (const item of items) {
    const groupDate = item.releaseGroupDate ?? item.releaseDate;
    const key =
      splitFutureReleases && groupDate > today
        ? `feed:${item.id}`
        : (item.releaseId ?? `${item.releaseTitle}:${groupDate}:${item.releaseType}`);
    const group = groups.get(key);
    if (group) {
      group.items.push(item);
    } else {
      groups.set(key, {
        artist: item.artist,
        items: [item],
        key,
        releaseDate: item.releaseGroupDate ?? item.releaseDate,
        releaseTitle: item.releaseTitle,
        releaseType: item.releaseType,
      });
    }
  }
  return [...groups.values()].map((group) => ({
    ...group,
    items: [...group.items].sort((left, right) => compareAppearanceOrder(left, right)),
  }));
}

function compareAppearanceOrder(left: FeedFixtureItem, right: FeedFixtureItem): number {
  return (
    (left.discNumber ?? 1) - (right.discNumber ?? 1) ||
    (left.trackNumber ?? left.providerOrder ?? Number.MAX_SAFE_INTEGER) -
      (right.trackNumber ?? right.providerOrder ?? Number.MAX_SAFE_INTEGER) ||
    (left.providerOrder ?? Number.MAX_SAFE_INTEGER) -
      (right.providerOrder ?? Number.MAX_SAFE_INTEGER) ||
    left.title.localeCompare(right.title, "en-US") ||
    left.id.localeCompare(right.id, "en-US")
  );
}

function calculateFeedSummary(items: FeedFixtureItem[], now = new Date()) {
  const startOfWeek = new Date(now);
  startOfWeek.setHours(0, 0, 0, 0);
  startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7));

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const endOfUpcomingWindow = new Date(startOfToday);
  endOfUpcomingWindow.setDate(endOfUpcomingWindow.getDate() + 30);
  endOfUpcomingWindow.setHours(23, 59, 59, 999);

  return {
    newThisWeek: items.filter((item) => {
      const firstSeenAt = Date.parse(item.firstSeenAt);
      return Number.isFinite(firstSeenAt) && firstSeenAt >= startOfWeek.getTime();
    }).length,
    upcoming: items.filter((item) => {
      const releaseDate = Date.parse(`${item.releaseDate.slice(0, 10)}T00:00:00`);
      return (
        Number.isFinite(releaseDate) &&
        releaseDate >= startOfToday.getTime() &&
        releaseDate <= endOfUpcomingWindow.getTime()
      );
    }).length,
  };
}

function getStreamingSourceTags(
  item: FeedFixtureItem,
  soundCloudLink: SoundCloudLinkRecord | undefined,
) {
  const sourceNames = item.sources.map((source) =>
    source.provider.trim().toLocaleLowerCase("en-US"),
  );
  return streamingSourceDefinitions.filter((definition) => {
    if (definition.id === "soundcloud" && soundCloudLink?.state === "USER_LINKED_VERIFIED") {
      return true;
    }
    return sourceNames.some((sourceName) =>
      definition.sourcePrefixes.some((prefix) => sourceName.startsWith(prefix)),
    );
  });
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

function discoveryPlaylistStatusLabel(
  schedule: DiscoveryScheduleStatus,
  spotifyCooldown: boolean,
): string {
  if (
    spotifyCooldown &&
    ["ready", "exporting", "partial", "failed"].includes(schedule.playlistInbox.status)
  ) {
    return "Export paused by cooldown";
  }
  switch (schedule.playlistInbox.status) {
    case "pending":
      return ["apple_priority", "apple_catchup_priority", "cooldown_wait"].includes(schedule.phase)
        ? "Awaiting Spotify resolution"
        : "Awaiting playlist export";
    case "ready":
      return "Awaiting playlist export";
    case "exporting":
      return "Exporting";
    case "partial":
    case "failed":
      return "Awaiting playlist export retry";
    case "completed":
      return "Export complete";
  }
}

function formatDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${month}/${day}/${year}`;
}

function formatReleaseGroupDate(value: string, now = new Date()): string {
  const today = now.toISOString().slice(0, 10);
  return `${value > today ? "Expected" : "Released"} ${formatDate(value)}`;
}

function formatReleaseTitleDate(
  value: string,
  precision: FeedFixtureItem["releaseDatePrecision"] = "day",
): string {
  const [yearValue, monthValue, dayValue] = value.split("-").map(Number);
  const year = yearValue ?? 1970;
  const month = monthValue ?? 1;
  const day = dayValue ?? 1;
  if (precision === "year") return String(year);

  const releaseDate = new Date(Date.UTC(year, month - 1, day));
  if (precision === "month") {
    return new Intl.DateTimeFormat("en-US", {
      month: "long",
      timeZone: "UTC",
      year: "numeric",
    }).format(releaseDate);
  }

  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
  }).format(releaseDate);
  return `${weekday}, ${month}/${day}/${String(year).slice(-2)}`;
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
