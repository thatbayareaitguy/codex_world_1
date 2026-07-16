import type { ProviderName, ProviderScanResult, ScanFilter, TrackCandidate } from "@radar/core";

export interface ScanContext {
  cursor?: string;
  filter: ScanFilter;
  signal?: AbortSignal;
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
