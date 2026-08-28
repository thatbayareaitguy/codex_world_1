export const providerNames = [
  "mock",
  "spotify",
  "musicbrainz",
  "reddit",
  "youtube",
  "soundcloud",
  "apple_music",
  "tidal",
] as const;

export type ProviderName = (typeof providerNames)[number];

export const releaseTypes = [
  "single",
  "ep",
  "album",
  "compilation",
  "remix",
  "live",
  "mixtape",
  "dj_mix",
  "demo",
  "soundtrack",
  "feature",
  "upload",
  "other",
  "radio_show",
  "podcast",
  "playlist",
  "unknown",
] as const;

export type ReleaseType = (typeof releaseTypes)[number];

export const feedStates = [
  "new",
  "upcoming",
  "saved",
  "dismissed",
  "listened",
  "needs_review",
] as const;

export type FeedState = (typeof feedStates)[number];

export type AvailabilityState = "playable" | "preview" | "blocked" | "unavailable";

export const soundCloudLinkStates = [
  "NOT_CHECKED",
  "SEARCH_LINK_AVAILABLE",
  "USER_LINKED_UNVERIFIED",
  "USER_LINKED_VERIFIED",
  "USER_LINK_REJECTED",
] as const;

export type SoundCloudLinkState = (typeof soundCloudLinkStates)[number];

export interface SoundCloudLinkRecord {
  feedItemId: string;
  rejectedAt?: string;
  state: SoundCloudLinkState;
  url: string;
  verifier?: string;
  verifiedAt?: string;
}

export interface ArtistCreditInput {
  name: string;
  canonicalArtistId?: string;
  role: "primary" | "featured" | "remixer" | "producer";
}

export interface SpotifyArtworkImage {
  height: number | null;
  url: string;
  width: number | null;
}

export interface SpotifyReleaseArtwork {
  albumId: string;
  albumUrl: string;
  image: SpotifyArtworkImage;
  lastObservedAt: string;
  sourceProvider: "spotify";
}

export interface AppleMusicReleaseArtwork {
  albumId: string;
  albumUrl: string;
  image: {
    height: number;
    url: string;
    width: number;
  };
  lastObservedAt: string;
  sourceProvider: "apple_music";
}

export interface TrackCandidate {
  provider: ProviderName;
  externalReleaseId: string;
  externalTrackId: string;
  sourceLabel: string;
  artistExternalId: string;
  artistName: string;
  title: string;
  releaseTitle: string;
  releaseType: ReleaseType;
  releaseDate: string;
  releaseDatePrecision: "day" | "month" | "year";
  firstSeenAt: string;
  credits: ArtistCreditInput[];
  durationMs?: number;
  isrc?: string;
  upc?: string;
  ean?: string;
  discNumber?: number;
  trackNumber?: number;
  musicbrainzRecordingId?: string;
  musicbrainzReleaseGroupId?: string;
  version?: string;
  region: string;
  availability: AvailabilityState;
  providerUrl: string;
  evidenceUrl: string;
  evidenceType: string;
  payloadHash: string;
  isUpcoming?: boolean;
  appleMusicRelease?: AppleMusicReleaseArtwork;
  spotifyRelease?: SpotifyReleaseArtwork;
}

export interface CanonicalTrack {
  id: string;
  title: string;
  normalizedTitle: string;
  credits: ArtistCreditInput[];
  durationMs?: number;
  isrc?: string;
  upc?: string;
  ean?: string;
  discNumber?: number;
  trackNumber?: number;
  musicbrainzRecordingId?: string;
  musicbrainzReleaseGroupId?: string;
  version?: string;
}

export type MatchRule =
  | "exact_provider_id"
  | "exact_isrc"
  | "exact_barcode_position"
  | "exact_musicbrainz"
  | "metadata"
  | "new_canonical"
  | "manual_review";

export interface MatchDecision {
  kind: "automatic" | "new" | "review";
  rule: MatchRule;
  confidence: number;
  reasons: string[];
  canonicalTrackId?: string;
}

export interface ScanFilter {
  artistId?: string;
  artistExternalId?: string;
  full?: boolean;
  provider?: ProviderName;
  since?: string;
}

export interface ProviderScanResult {
  candidates: TrackCandidate[];
  nextCursor?: string;
  providerMetrics?: {
    failures: number;
    requests: number;
    waitMs: number;
  };
}

export interface FeedFixtureItem {
  id: string;
  state: FeedState;
  saved: boolean;
  listened: boolean;
  artist: string;
  title: string;
  releaseId?: string;
  releaseTitle: string;
  releaseType: ReleaseType;
  releaseDate: string;
  releaseGroupDate?: string;
  releaseDatePrecision?: "day" | "month" | "year";
  releaseCompleteness?: {
    expectedTracks: number;
    fetchedTracks: number;
    missingTracks: number;
    status:
      | "not_started"
      | "in_progress"
      | "partial"
      | "completed"
      | "paused"
      | "rate_limited"
      | "failed";
  };
  discNumber?: number;
  trackNumber?: number;
  providerOrder?: number;
  firstSeenAt: string;
  sources: Array<{ provider: string; href: string; evidenceHref: string }>;
  spotify: AvailabilityState;
  spotifyResolution?: {
    mode: "automatic" | "manual";
    status: "queued" | "verifying" | "mismatch";
  };
  review?: {
    candidateId: string;
    deferredUntil?: string;
    provider: ProviderName;
    providerUrl?: string;
  };
  spotifyArtwork?: SpotifyReleaseArtwork;
  appleMusicArtwork?: AppleMusicReleaseArtwork;
  soundcloudState: SoundCloudLinkState;
  links: Array<{ label: string; href: string }>;
  confidence: number;
  matchReason: string;
  region: string;
  exportStatus: "eligible" | "exported" | "blocked" | "review_required";
  accent: "coral" | "cyan" | "lime" | "gold";
  reddit?: {
    subreddit: string;
    postCreatedAt: string;
    parseConfidence: number;
    artistMatchConfidence: number;
    corroboration: "reddit_only" | "spotify" | "musicbrainz" | "user_confirmed";
    directSpotifyLink: boolean;
    unverifiedExternalLink: boolean;
    sourceDeleted: boolean;
  };
}
