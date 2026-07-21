import type { ProviderName, ProviderScanResult, ScanFilter, TrackCandidate } from "@radar/core";

export interface ScanContext {
  cursor?: string;
  filter: ScanFilter;
  onBatch?: (batch: ProviderScanBatch) => Promise<void>;
  onPage?: (page: ProviderScanPage) => Promise<void>;
  onUnitStart?: (unit: ProviderScanUnit) => Promise<boolean>;
  signal?: AbortSignal;
}

export interface ProviderScanPage {
  albumDetailRequests: number;
  candidates: TrackCandidate[];
  currentUnit: string;
  currentUnitId: string;
  durationMs: number;
  finishedAt: Date;
  itemCount: number;
  nextOffset: number | null;
  offset: number;
  pageNumber: number;
  providerMetrics: {
    failures: number;
    requests: number;
    waitMs: number;
  };
  releases: ProviderReleaseObservation[];
  startedAt: Date;
  totalItems: number;
}

export interface ProviderScanBatch {
  candidates: TrackCandidate[];
  completedUnits: number;
  currentUnit: string;
  currentUnitId?: string;
  stage?: string;
  lastPersistedResult?: string;
  releaseGroupCount?: number;
  releaseCount?: number;
  pagesScanned?: number;
  partial?: boolean;
  providerMetrics?: {
    failures: number;
    requests: number;
    waitMs: number;
  };
  releases?: ProviderReleaseObservation[];
  totalUnits: number;
}

export interface ProviderReleaseObservation {
  backfillEligible: boolean;
  candidateCount: number;
  externalReleaseId: string;
  reasons: string[];
  releaseDate: string;
  releaseDatePrecision: "day" | "month" | "year";
  releaseType: string;
  selectedForDetails: boolean;
  title: string;
  totalTracks: number;
}

export interface ProviderScanUnit {
  currentUnit: string;
  currentUnitId: string;
  position: number;
  totalUnits: number;
}

export interface FollowedArtistRecord {
  externalId: string;
  name: string;
  providerUrl: string;
}

export interface PlaylistItemInput {
  providerTrackId: string;
  providerUrl: string;
  matchRule: string;
  confidence: number;
  manuallyConfirmed: boolean;
}

export interface PlaylistSyncResult {
  externalPlaylistId: string;
  added: string[];
  alreadyPresent: string[];
  rejected: Array<{ providerTrackId: string; reason: string }>;
}

export interface DiscoveryProvider {
  readonly name: ProviderName;
  scan(context: ScanContext): Promise<ProviderScanResult>;
}

export interface AccountImportProvider {
  importFollowedArtists(signal?: AbortSignal): Promise<FollowedArtistRecord[]>;
}

export interface PlaylistWriterProvider {
  syncPrivatePlaylist(
    externalPlaylistId: string | undefined,
    items: PlaylistItemInput[],
    signal?: AbortSignal,
  ): Promise<PlaylistSyncResult>;
}

export interface FutureCatalogProvider extends DiscoveryProvider {
  readonly implementationStatus: "interface_only";
}

export type ValidatedCandidate = TrackCandidate;
