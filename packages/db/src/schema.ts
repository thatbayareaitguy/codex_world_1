import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const providerEnum = pgEnum("provider", [
  "mock",
  "spotify",
  "musicbrainz",
  "reddit",
  "youtube",
  "soundcloud",
  "apple_music",
  "tidal",
]);
export const releaseTypeEnum = pgEnum("release_type", [
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
]);
export const feedStateEnum = pgEnum("feed_state", [
  "new",
  "upcoming",
  "saved",
  "dismissed",
  "listened",
  "needs_review",
]);
export const availabilityEnum = pgEnum("availability_state", [
  "playable",
  "preview",
  "blocked",
  "unavailable",
]);
export const scanStatusEnum = pgEnum("scan_status", [
  "running",
  "completed",
  "partial",
  "failed",
  "cancelled",
  "paused",
  "rate_limited",
]);
export const spotifyBatchStatusEnum = pgEnum("spotify_batch_status", [
  "pending",
  "running",
  "completed",
  "paused",
  "cancelled",
  "rate_limited",
  "blocked_mapping",
  "failed",
]);
export const spotifyArtistScanStatusEnum = pgEnum("spotify_artist_scan_status", [
  "pending",
  "running",
  "completed",
  "partial",
  "paused",
  "cancelled",
  "rate_limited",
  "blocked_mapping",
  "failed",
]);
export const spotifyReleaseTrackStatusEnum = pgEnum("spotify_release_track_status", [
  "not_started",
  "in_progress",
  "partial",
  "completed",
  "paused",
  "rate_limited",
  "failed",
]);
export const musicbrainzBatchStatusEnum = pgEnum("musicbrainz_batch_status", [
  "pending",
  "running",
  "completed",
  "paused",
  "cancelled",
  "failed",
]);
export const musicbrainzArtistScanStatusEnum = pgEnum("musicbrainz_artist_scan_status", [
  "pending",
  "running",
  "completed",
  "paused",
  "cancelled",
  "failed",
]);
export const matchStatusEnum = pgEnum("match_status", [
  "new",
  "matched",
  "needs_review",
  "rejected",
]);
export const exportStatusEnum = pgEnum("export_status", [
  "pending",
  "exported",
  "skipped",
  "failed",
]);
export const externalLinkTypeEnum = pgEnum("external_link_type", ["artist_profile", "track"]);
export const externalLinkStateEnum = pgEnum("external_link_state", [
  "NOT_CHECKED",
  "SEARCH_LINK_AVAILABLE",
  "USER_LINKED_UNVERIFIED",
  "USER_LINKED_VERIFIED",
  "USER_LINK_REJECTED",
]);
export const importStatusEnum = pgEnum("import_status", [
  "preview",
  "confirmed",
  "completed",
  "partial",
  "failed",
]);

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: providerEnum("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    providerUserId: text("provider_user_id"),
    displayName: text("display_name"),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    encryptedRefreshToken: text("encrypted_refresh_token"),
    tokenNonce: text("token_nonce"),
    encryptedAccessToken: text("encrypted_access_token"),
    accessTokenNonce: text("access_token_nonce"),
    keyVersion: integer("key_version"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    lastTokenRefreshAt: timestamp("last_token_refresh_at", { withTimezone: true }),
    reconnectRequired: boolean("reconnect_required").notNull().default(false),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("oauth_accounts_provider_identity_unique").on(
      table.provider,
      table.providerAccountId,
    ),
  ],
);

export const oauthStates = pgTable(
  "oauth_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: providerEnum("provider").notNull(),
    stateHash: text("state_hash").notNull(),
    encryptedCodeVerifier: text("encrypted_code_verifier").notNull(),
    verifierNonce: text("verifier_nonce").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt,
  },
  (table) => [uniqueIndex("oauth_states_state_hash_unique").on(table.stateHash)],
);

export const artists = pgTable(
  "artists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    sortName: text("sort_name"),
    createdAt,
    updatedAt,
  },
  (table) => [index("artists_normalized_name_idx").on(table.normalizedName)],
);

export const artistAliases = pgTable(
  "artist_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artistId: uuid("artist_id")
      .notNull()
      .references(() => artists.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    source: text("source").notNull().default("user"),
    createdAt,
  },
  (table) => [
    uniqueIndex("artist_aliases_artist_name_unique").on(table.artistId, table.normalizedName),
  ],
);

export const artistExternalIds = pgTable(
  "artist_external_ids",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artistId: uuid("artist_id")
      .notNull()
      .references(() => artists.id, { onDelete: "cascade" }),
    provider: providerEnum("provider").notNull(),
    externalId: text("external_id").notNull(),
    providerUrl: text("provider_url"),
    confirmed: boolean("confirmed").notNull().default(false),
    matchScore: numeric("match_score", { precision: 4, scale: 3 }),
    matchReasons: text("match_reasons")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    mappingSource: text("mapping_source").notNull().default("manual"),
    importedAt: timestamp("imported_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("artist_external_provider_id_unique").on(table.provider, table.externalId),
    uniqueIndex("artist_external_artist_provider_unique").on(table.artistId, table.provider),
  ],
);

export const artistFollows = pgTable(
  "artist_follows",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    artistId: uuid("artist_id")
      .notNull()
      .references(() => artists.id, { onDelete: "cascade" }),
    followedAt: timestamp("followed_at", { withTimezone: true }).notNull().defaultNow(),
    active: boolean("active").notNull().default(true),
    source: text("source").notNull().default("manual"),
    inclusionRules: jsonb("inclusion_rules")
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (table) => [primaryKey({ columns: [table.userId, table.artistId] })],
);

export const artistImportRuns = pgTable("artist_import_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  provider: providerEnum("provider").notNull(),
  status: importStatusEnum("status").notNull().default("preview"),
  retrievedCount: integer("retrieved_count").notNull().default(0),
  createdCount: integer("created_count").notNull().default(0),
  mergedCount: integer("merged_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  reviewCount: integer("review_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt,
});

export const artistImportCandidates = pgTable(
  "artist_import_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importRunId: uuid("import_run_id")
      .notNull()
      .references(() => artistImportRuns.id, { onDelete: "cascade" }),
    providerArtistId: text("provider_artist_id").notNull(),
    providerUrl: text("provider_url").notNull(),
    providerName: text("provider_name").notNull(),
    existingArtistId: uuid("existing_artist_id").references(() => artists.id, {
      onDelete: "set null",
    }),
    proposedAction: text("proposed_action").notNull(),
    selected: boolean("selected").notNull().default(false),
    decision: text("decision"),
    createdAt,
  },
  (table) => [
    uniqueIndex("artist_import_candidate_provider_unique").on(
      table.importRunId,
      table.providerArtistId,
    ),
  ],
);

export const artistMappingReviews = pgTable(
  "artist_mapping_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artistId: uuid("artist_id")
      .notNull()
      .references(() => artists.id, { onDelete: "cascade" }),
    provider: providerEnum("provider").notNull(),
    proposedExternalId: text("proposed_external_id").notNull(),
    providerName: text("provider_name").notNull(),
    matchScore: numeric("match_score", { precision: 4, scale: 3 }).notNull(),
    matchReasons: text("match_reasons").array().notNull(),
    status: text("status").notNull().default("pending"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("artist_mapping_review_proposal_unique").on(
      table.artistId,
      table.provider,
      table.proposedExternalId,
    ),
    index("artist_mapping_review_pending_idx").on(
      table.provider,
      table.status,
      table.updatedAt,
      table.id,
    ),
  ],
);

export const releases = pgTable(
  "releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    normalizedTitle: text("normalized_title").notNull(),
    releaseType: releaseTypeEnum("release_type").notNull(),
    releaseDate: date("release_date").notNull(),
    releaseDatePrecision: text("release_date_precision").notNull(),
    upc: text("upc"),
    ean: text("ean"),
    version: text("version"),
    createdAt,
    updatedAt,
  },
  (table) => [
    index("releases_title_date_idx").on(table.normalizedTitle, table.releaseDate),
    uniqueIndex("releases_upc_unique")
      .on(table.upc)
      .where(sql`${table.upc} is not null`),
    uniqueIndex("releases_ean_unique")
      .on(table.ean)
      .where(sql`${table.ean} is not null`),
  ],
);

export const tracks = pgTable(
  "tracks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    releaseId: uuid("release_id").references(() => releases.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    normalizedTitle: text("normalized_title").notNull(),
    durationMs: integer("duration_ms"),
    isrc: text("isrc"),
    discNumber: integer("disc_number"),
    trackNumber: integer("track_number"),
    musicbrainzRecordingId: text("musicbrainz_recording_id"),
    musicbrainzReleaseGroupId: text("musicbrainz_release_group_id"),
    version: text("version"),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("tracks_isrc_unique")
      .on(table.isrc)
      .where(sql`${table.isrc} is not null`),
    uniqueIndex("tracks_musicbrainz_recording_unique")
      .on(table.musicbrainzRecordingId)
      .where(sql`${table.musicbrainzRecordingId} is not null`),
    index("tracks_normalized_title_idx").on(table.normalizedTitle),
  ],
);

export const releaseExternalIds = pgTable(
  "release_external_ids",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => releases.id, { onDelete: "cascade" }),
    provider: providerEnum("provider").notNull(),
    externalId: text("external_id").notNull(),
    providerUrl: text("provider_url").notNull(),
    providerFields: jsonb("provider_fields")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("release_external_provider_id_unique").on(table.provider, table.externalId),
    index("release_external_release_provider_idx").on(table.releaseId, table.provider),
  ],
);

export const trackExternalIds = pgTable(
  "track_external_ids",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    provider: providerEnum("provider").notNull(),
    externalId: text("external_id").notNull(),
    providerUrl: text("provider_url").notNull(),
    providerFields: jsonb("provider_fields")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("track_external_provider_id_unique").on(table.provider, table.externalId),
    index("track_external_track_provider_idx").on(table.trackId, table.provider),
  ],
);

export const externalLinks = pgTable(
  "external_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    artistId: uuid("artist_id").references(() => artists.id, { onDelete: "cascade" }),
    trackId: uuid("track_id").references(() => tracks.id, { onDelete: "cascade" }),
    service: text("service").notNull(),
    linkType: externalLinkTypeEnum("link_type").notNull(),
    url: text("url").notNull(),
    state: externalLinkStateEnum("state").notNull(),
    verifiedBy: uuid("verified_by").references(() => users.id, { onDelete: "set null" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    check(
      "external_links_exactly_one_target_check",
      sql`(case when ${table.artistId} is null then 0 else 1 end + case when ${table.trackId} is null then 0 else 1 end) = 1`,
    ),
    check(
      "external_links_soundcloud_https_check",
      sql`${table.service} <> 'soundcloud' or ${table.url} ~ '^https://([a-z0-9-]+\\.)*soundcloud\\.com/'`,
    ),
    uniqueIndex("external_links_user_artist_service_unique")
      .on(table.userId, table.artistId, table.service, table.linkType)
      .where(sql`${table.artistId} is not null`),
    uniqueIndex("external_links_user_track_service_unique")
      .on(table.userId, table.trackId, table.service, table.linkType)
      .where(sql`${table.trackId} is not null`),
    index("external_links_verified_collection_idx").on(table.userId, table.service, table.state),
  ],
);

export const trackCredits = pgTable(
  "track_credits",
  {
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    artistId: uuid("artist_id")
      .notNull()
      .references(() => artists.id, { onDelete: "restrict" }),
    creditOrder: integer("credit_order").notNull(),
    role: text("role").notNull(),
    creditedName: text("credited_name").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.trackId, table.artistId, table.role] }),
    uniqueIndex("track_credits_order_unique").on(table.trackId, table.creditOrder),
  ],
);

export const trackAvailabilities = pgTable(
  "track_availabilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    provider: providerEnum("provider").notNull(),
    providerTrackId: text("provider_track_id").notNull(),
    region: text("region").notNull(),
    state: availabilityEnum("state").notNull(),
    providerUrl: text("provider_url").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("track_availability_provider_track_region_unique").on(
      table.provider,
      table.providerTrackId,
      table.region,
    ),
    index("track_availability_track_provider_idx").on(table.trackId, table.provider),
  ],
);

export const scanRuns = pgTable(
  "scan_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: providerEnum("provider"),
    status: scanStatusEnum("status").notNull().default("running"),
    dryRun: boolean("dry_run").notNull().default(false),
    triggerType: text("trigger_type").notNull().default("manual"),
    providersRequested: text("providers_requested")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    providersCompleted: text("providers_completed")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    providersFailed: text("providers_failed")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    artistFilter: text("artist_filter"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    discoveredCount: integer("discovered_count").notNull().default(0),
    insertedCount: integer("inserted_count").notNull().default(0),
    updatedCount: integer("updated_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    reviewCount: integer("review_count").notNull().default(0),
    playlistAdditionCount: integer("playlist_addition_count").notNull().default(0),
    artistsProcessedCount: integer("artists_processed_count").notNull().default(0),
    duplicatesIgnoredCount: integer("duplicates_ignored_count").notNull().default(0),
    detailedExpiresAt: timestamp("detailed_expires_at", { withTimezone: true }),
    providerResults: jsonb("provider_results")
      .notNull()
      .default(sql`'{}'::jsonb`),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    errors: jsonb("errors")
      .notNull()
      .default(sql`'[]'::jsonb`),
  },
  (table) => [
    index("scan_runs_started_history_idx").on(table.startedAt, table.id),
    index("scan_runs_status_provider_started_idx").on(
      table.status,
      table.provider,
      table.startedAt,
    ),
  ],
);

export const spotifyProviderState = pgTable("spotify_provider_state", {
  id: text("id").primaryKey().default("global"),
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
  cooldownIndefinite: boolean("cooldown_indefinite").notNull().default(false),
  cooldownObservedAt: timestamp("cooldown_observed_at", { withTimezone: true }),
  cooldownEndpointCategory: text("cooldown_endpoint_category"),
  cooldownStatus: integer("cooldown_status"),
  rawRetryAfter: text("raw_retry_after"),
  parsedRetryAfterSeconds: text("parsed_retry_after_seconds"),
  cooldownErrorClassification: text("cooldown_error_classification"),
  cooldownResponseClassification: text("cooldown_response_classification"),
  nextRequestAt: timestamp("next_request_at", { withTimezone: true }),
  lastRequestStartedAt: timestamp("last_request_started_at", { withTimezone: true }),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  queueDepth: integer("queue_depth").notNull().default(0),
  requestCount: integer("request_count").notNull().default(0),
  manualClearAt: timestamp("manual_clear_at", { withTimezone: true }),
  manualClearReason: text("manual_clear_reason"),
  updatedAt,
});

export const spotifyRequestEvents = pgTable(
  "spotify_request_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    endpointCategory: text("endpoint_category").notNull(),
    method: text("method").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    status: integer("status"),
    queueWaitMs: integer("queue_wait_ms").notNull().default(0),
    rawRetryAfter: text("raw_retry_after"),
    parsedRetryAfterSeconds: text("parsed_retry_after_seconds"),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
    errorClassification: text("error_classification"),
    responseClassification: text("response_classification"),
    createdAt,
  },
  (table) => [index("spotify_request_events_started_idx").on(table.startedAt)],
);

export const musicbrainzProviderState = pgTable("musicbrainz_provider_state", {
  id: text("id").primaryKey().default("global"),
  nextRequestAt: timestamp("next_request_at", { withTimezone: true }),
  lastRequestStartedAt: timestamp("last_request_started_at", { withTimezone: true }),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  queueDepth: integer("queue_depth").notNull().default(0),
  requestCount: integer("request_count").notNull().default(0),
  updatedAt,
});

export const musicbrainzRequestEvents = pgTable(
  "musicbrainz_request_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    endpointCategory: text("endpoint_category").notNull(),
    method: text("method").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    status: integer("status"),
    queueWaitMs: integer("queue_wait_ms").notNull().default(0),
    retryAttempt: integer("retry_attempt").notNull().default(1),
    errorClassification: text("error_classification"),
    createdAt,
  },
  (table) => [index("musicbrainz_request_events_started_idx").on(table.startedAt)],
);

export const musicbrainzScanBatches = pgTable(
  "musicbrainz_scan_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scanRunId: uuid("scan_run_id").references(() => scanRuns.id, { onDelete: "set null" }),
    status: musicbrainzBatchStatusEnum("status").notNull().default("pending"),
    totalArtists: integer("total_artists").notNull(),
    completedArtists: integer("completed_artists").notNull().default(0),
    failedArtists: integer("failed_artists").notNull().default(0),
    cancelledArtists: integer("cancelled_artists").notNull().default(0),
    pauseRequested: boolean("pause_requested").notNull().default(false),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [index("musicbrainz_scan_batches_status_idx").on(table.status, table.createdAt)],
);

export const musicbrainzArtistScans = pgTable(
  "musicbrainz_artist_scans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => musicbrainzScanBatches.id, { onDelete: "cascade" }),
    artistId: uuid("artist_id")
      .notNull()
      .references(() => artists.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    status: musicbrainzArtistScanStatusEnum("status").notNull().default("pending"),
    stage: text("stage").notNull().default("pending"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    requestCount: integer("request_count").notNull().default(0),
    candidateCount: integer("candidate_count").notNull().default(0),
    releaseGroupCount: integer("release_group_count").notNull().default(0),
    releaseCount: integer("release_count").notNull().default(0),
    errorClassification: text("error_classification"),
    lastPersistedAt: timestamp("last_persisted_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("musicbrainz_artist_scans_batch_artist_unique").on(table.batchId, table.artistId),
    uniqueIndex("musicbrainz_artist_scans_batch_position_unique").on(table.batchId, table.position),
    index("musicbrainz_artist_scans_status_idx").on(table.status, table.updatedAt),
  ],
);

export const spotifyScanBatches = pgTable(
  "spotify_scan_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scanRunId: uuid("scan_run_id").references(() => scanRuns.id, { onDelete: "set null" }),
    mode: text("mode").notNull(),
    status: spotifyBatchStatusEnum("status").notNull().default("pending"),
    pageLimit: integer("page_limit").notNull(),
    totalArtists: integer("total_artists").notNull(),
    completedArtists: integer("completed_artists").notNull().default(0),
    failedArtists: integer("failed_artists").notNull().default(0),
    partialArtists: integer("partial_artists").notNull().default(0),
    cancelledArtists: integer("cancelled_artists").notNull().default(0),
    rateLimitedArtists: integer("rate_limited_artists").notNull().default(0),
    blockedMappingArtists: integer("blocked_mapping_artists").notNull().default(0),
    estimatedRequests: integer("estimated_requests").notNull().default(0),
    pauseRequested: boolean("pause_requested").notNull().default(false),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    confirmationRequired: boolean("confirmation_required").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [index("spotify_scan_batches_status_idx").on(table.status, table.createdAt)],
);

export const spotifyArtistScans = pgTable(
  "spotify_artist_scans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => spotifyScanBatches.id, { onDelete: "cascade" }),
    artistId: uuid("artist_id")
      .notNull()
      .references(() => artists.id, { onDelete: "cascade" }),
    providerArtistId: text("provider_artist_id"),
    position: integer("position").notNull(),
    status: spotifyArtistScanStatusEnum("status").notNull().default("pending"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    requestCount: integer("request_count").notNull().default(0),
    candidateCount: integer("candidate_count").notNull().default(0),
    releaseCount: integer("release_count"),
    backfillReleaseCount: integer("backfill_release_count"),
    pagesScanned: integer("pages_scanned").notNull().default(0),
    errorClassification: text("error_classification"),
    retryEligibleAt: timestamp("retry_eligible_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("spotify_artist_scans_batch_artist_unique").on(table.batchId, table.artistId),
    uniqueIndex("spotify_artist_scans_batch_position_unique").on(table.batchId, table.position),
    index("spotify_artist_scans_status_idx").on(table.status, table.updatedAt),
  ],
);

export const spotifyArtistCoverage = pgTable(
  "spotify_artist_coverage",
  {
    artistId: uuid("artist_id")
      .primaryKey()
      .references(() => artists.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("reconciliation_queued"),
    dailyScanCompletedAt: timestamp("daily_scan_completed_at", { withTimezone: true }),
    reconciliationStartedAt: timestamp("reconciliation_started_at", { withTimezone: true }),
    reconciliationCompletedAt: timestamp("reconciliation_completed_at", { withTimezone: true }),
    nextOffset: integer("next_offset").notNull().default(0),
    pagesScannedInCycle: integer("pages_scanned_in_cycle").notNull().default(0),
    catalogPagesCompleted: integer("catalog_pages_completed").notNull().default(0),
    estimatedTotalPages: integer("estimated_total_pages"),
    partial: boolean("partial").notNull().default(true),
    lastPageScannedAt: timestamp("last_page_scanned_at", { withTimezone: true }),
    lastFullReconciliationAt: timestamp("last_full_reconciliation_at", { withTimezone: true }),
    lastReconciliationError: text("last_reconciliation_error"),
    reconciliationCycleId: uuid("reconciliation_cycle_id"),
    createdAt,
    updatedAt,
  },
  (table) => [
    index("spotify_artist_coverage_status_idx").on(table.status, table.updatedAt),
    index("spotify_artist_coverage_reconcile_idx").on(table.partial, table.status, table.updatedAt),
  ],
);

export const spotifyCatalogReleases = pgTable(
  "spotify_catalog_releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artistId: uuid("artist_id")
      .notNull()
      .references(() => artists.id, { onDelete: "cascade" }),
    externalReleaseId: text("external_release_id").notNull(),
    title: text("title").notNull(),
    releaseDate: date("release_date").notNull(),
    releaseDatePrecision: text("release_date_precision").notNull(),
    releaseType: text("release_type").notNull(),
    totalTracks: integer("total_tracks").notNull(),
    summaryHash: text("summary_hash").notNull(),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull().defaultNow(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull().defaultNow(),
    detailsFetchedAt: timestamp("details_fetched_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("spotify_catalog_releases_artist_release_unique").on(
      table.artistId,
      table.externalReleaseId,
    ),
    index("spotify_catalog_releases_observed_idx").on(table.artistId, table.lastObservedAt),
  ],
);

export const spotifyReleaseTrackRetrievals = pgTable(
  "spotify_release_track_retrievals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    releaseId: uuid("release_id").references(() => releases.id, { onDelete: "set null" }),
    spotifyAlbumId: text("spotify_album_id").notNull(),
    expectedTotalTracks: integer("expected_total_tracks").notNull(),
    fetchedTrackCount: integer("fetched_track_count").notNull().default(0),
    nextOffset: integer("next_offset"),
    pagesCompleted: integer("pages_completed").notNull().default(0),
    status: spotifyReleaseTrackStatusEnum("status").notNull().default("not_started"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    lastPageCompletedAt: timestamp("last_page_completed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastErrorClassification: text("last_error_classification"),
    retryEligibleAt: timestamp("retry_eligible_at", { withTimezone: true }),
    discrepancy: text("discrepancy"),
    reconciliationCycleId: uuid("reconciliation_cycle_id"),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("spotify_release_track_retrieval_album_unique").on(table.spotifyAlbumId),
    index("spotify_release_track_retrieval_status_idx").on(table.status, table.updatedAt),
    index("spotify_release_track_retrieval_resume_idx").on(
      table.status,
      table.nextOffset,
      table.updatedAt,
    ),
    index("spotify_release_track_retrieval_release_idx").on(table.releaseId),
  ],
);

export const spotifyReleaseTrackPages = pgTable(
  "spotify_release_track_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    retrievalId: uuid("retrieval_id")
      .notNull()
      .references(() => spotifyReleaseTrackRetrievals.id, { onDelete: "cascade" }),
    offset: integer("offset").notNull(),
    itemCount: integer("item_count").notNull(),
    uniqueItemCount: integer("unique_item_count").notNull(),
    nextOffset: integer("next_offset"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex("spotify_release_track_pages_retrieval_offset_unique").on(
      table.retrievalId,
      table.offset,
    ),
  ],
);

export const spotifyReleaseTrackItems = pgTable(
  "spotify_release_track_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    retrievalId: uuid("retrieval_id")
      .notNull()
      .references(() => spotifyReleaseTrackRetrievals.id, { onDelete: "cascade" }),
    providerTrackId: text("provider_track_id").notNull(),
    pageOffset: integer("page_offset").notNull(),
    discNumber: integer("disc_number").notNull(),
    trackNumber: integer("track_number").notNull(),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull().defaultNow(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("spotify_release_track_items_retrieval_track_unique").on(
      table.retrievalId,
      table.providerTrackId,
    ),
    index("spotify_release_track_items_order_idx").on(
      table.retrievalId,
      table.discNumber,
      table.trackNumber,
    ),
  ],
);

export const spotifyPageScans = pgTable(
  "spotify_page_scans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => spotifyScanBatches.id, { onDelete: "cascade" }),
    artistScanId: uuid("artist_scan_id")
      .notNull()
      .references(() => spotifyArtistScans.id, { onDelete: "cascade" }),
    artistId: uuid("artist_id")
      .notNull()
      .references(() => artists.id, { onDelete: "cascade" }),
    reconciliationCycleId: uuid("reconciliation_cycle_id"),
    mode: text("mode").notNull(),
    dryRun: boolean("dry_run").notNull().default(false),
    pageNumber: integer("page_number").notNull(),
    spotifyOffset: integer("spotify_offset").notNull(),
    itemCount: integer("item_count").notNull(),
    totalItems: integer("total_items").notNull(),
    nextOffset: integer("next_offset"),
    anotherPage: boolean("another_page").notNull(),
    backfillReleaseCount: integer("backfill_release_count").notNull().default(0),
    candidateCount: integer("candidate_count").notNull().default(0),
    albumDetailRequests: integer("album_detail_requests").notNull().default(0),
    requestCount: integer("request_count").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex("spotify_page_scans_artist_offset_unique").on(
      table.artistScanId,
      table.spotifyOffset,
    ),
    index("spotify_page_scans_cycle_idx").on(table.artistId, table.reconciliationCycleId),
  ],
);

export const operationLocks = pgTable(
  "operation_locks",
  {
    lockKey: text("lock_key").primaryKey(),
    ownerToken: text("owner_token").notNull(),
    operationType: text("operation_type").notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("operation_locks_expiry_idx").on(table.expiresAt)],
);

export const scanLocks = pgTable(
  "scan_locks",
  {
    provider: providerEnum("provider").primaryKey(),
    ownerToken: text("owner_token").notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("scan_locks_expiry_idx").on(table.expiresAt)],
);

export const releaseCandidates = pgTable(
  "release_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scanRunId: uuid("scan_run_id").references(() => scanRuns.id, { onDelete: "set null" }),
    provider: providerEnum("provider").notNull(),
    providerReleaseId: text("provider_release_id").notNull(),
    providerTrackId: text("provider_track_id").notNull(),
    artistExternalId: text("artist_external_id").notNull(),
    title: text("title").notNull(),
    normalizedTitle: text("normalized_title").notNull(),
    releaseDate: date("release_date").notNull(),
    rawPayload: jsonb("raw_payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    matchStatus: matchStatusEnum("match_status").notNull(),
    matchedTrackId: uuid("matched_track_id").references(() => tracks.id, { onDelete: "set null" }),
    matchRule: text("match_rule").notNull(),
    matchConfidence: numeric("match_confidence", { precision: 4, scale: 3 }).notNull(),
    matchReasons: text("match_reasons").array().notNull(),
    matchingAlgorithmVersion: text("matching_algorithm_version").notNull().default("v1"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex("release_candidates_provider_release_track_unique").on(
      table.provider,
      table.providerReleaseId,
      table.providerTrackId,
    ),
    index("release_candidates_matched_track_seen_idx").on(table.matchedTrackId, table.firstSeenAt),
  ],
);

export const sourceEvidence = pgTable(
  "source_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => releaseCandidates.id, { onDelete: "cascade" }),
    provider: providerEnum("provider").notNull(),
    evidenceType: text("evidence_type").notNull(),
    externalId: text("external_id").notNull(),
    sourceUrl: text("source_url").notNull(),
    payloadHash: text("payload_hash").notNull(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("source_evidence_identity_unique").on(
      table.provider,
      table.evidenceType,
      table.externalId,
      table.payloadHash,
    ),
    index("source_evidence_candidate_idx").on(table.candidateId),
  ],
);

export const releaseTrackAppearances = pgTable(
  "release_track_appearances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => releases.id, { onDelete: "cascade" }),
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    discNumber: integer("disc_number").notNull().default(1),
    trackNumber: integer("track_number").notNull().default(1),
    providerOrder: integer("provider_order"),
    presentationMetadata: jsonb("presentation_metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull().defaultNow(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("release_track_appearance_identity_unique").on(
      table.releaseId,
      table.trackId,
      table.discNumber,
      table.trackNumber,
    ),
    index("release_track_appearance_release_order_idx").on(
      table.releaseId,
      table.discNumber,
      table.trackNumber,
    ),
    index("release_track_appearance_track_idx").on(table.trackId),
  ],
);

export const releaseTrackAppearanceSources = pgTable(
  "release_track_appearance_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appearanceId: uuid("appearance_id")
      .notNull()
      .references(() => releaseTrackAppearances.id, { onDelete: "cascade" }),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => releaseCandidates.id, { onDelete: "cascade" }),
    provider: providerEnum("provider").notNull(),
    providerReleaseId: text("provider_release_id").notNull(),
    providerTrackId: text("provider_track_id").notNull(),
    observedCredit: jsonb("observed_credit")
      .notNull()
      .default(sql`'[]'::jsonb`),
    firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull().defaultNow(),
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("release_track_appearance_source_candidate_unique").on(table.candidateId),
    uniqueIndex("release_track_appearance_source_provider_unique").on(
      table.provider,
      table.providerReleaseId,
      table.providerTrackId,
    ),
    index("release_track_appearance_source_appearance_idx").on(table.appearanceId),
  ],
);

export const upcomingAnnouncements = pgTable(
  "upcoming_announcements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artistId: uuid("artist_id")
      .notNull()
      .references(() => artists.id, { onDelete: "cascade" }),
    releaseId: uuid("release_id").references(() => releases.id, { onDelete: "set null" }),
    provider: providerEnum("provider").notNull(),
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    scheduledFor: date("scheduled_for"),
    datePrecision: text("date_precision").notNull().default("day"),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull().default("0.700"),
    evidenceUrl: text("evidence_url").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex("upcoming_provider_external_unique").on(table.provider, table.externalId),
  ],
);

export const upcomingDateHistory = pgTable(
  "upcoming_date_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    announcementId: uuid("announcement_id")
      .notNull()
      .references(() => upcomingAnnouncements.id, { onDelete: "cascade" }),
    scheduledFor: date("scheduled_for"),
    datePrecision: text("date_precision").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("upcoming_date_history_observation_unique").on(
      table.announcementId,
      table.scheduledFor,
      table.datePrecision,
    ),
  ],
);

export const feedItems = pgTable(
  "feed_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    candidateId: uuid("candidate_id").references(() => releaseCandidates.id, {
      onDelete: "cascade",
    }),
    releaseId: uuid("release_id").references(() => releases.id, { onDelete: "set null" }),
    trackId: uuid("track_id").references(() => tracks.id, { onDelete: "set null" }),
    appearanceId: uuid("appearance_id").references(() => releaseTrackAppearances.id, {
      onDelete: "set null",
    }),
    state: feedStateEnum("state").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    listenedAt: timestamp("listened_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    savedAt: timestamp("saved_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("feed_user_dedupe_unique").on(table.userId, table.dedupeKey),
    uniqueIndex("feed_user_appearance_unique")
      .on(table.userId, table.appearanceId)
      .where(sql`${table.appearanceId} is not null and ${table.state} <> 'needs_review'`),
    index("feed_user_state_seen_idx").on(table.userId, table.state, table.firstSeenAt),
    index("feed_user_seen_id_idx").on(table.userId, table.firstSeenAt, table.id),
    index("feed_user_release_seen_idx").on(table.userId, table.releaseId, table.firstSeenAt),
    index("feed_track_idx").on(table.trackId),
    index("feed_appearance_idx").on(table.appearanceId),
  ],
);

export const feedRevisions = pgTable("feed_revisions", {
  id: text("id").primaryKey().default("global"),
  revision: bigint("revision", { mode: "number" }).notNull().default(0),
  itemCount: integer("item_count").notNull().default(0),
  updatedAt,
});

export const playlistTargets = pgTable(
  "playlist_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: providerEnum("provider").notNull(),
    providerPlaylistId: text("provider_playlist_id"),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    autoAddExactMatches: boolean("auto_add_exact_matches").notNull().default(false),
    snapshotId: text("snapshot_id"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [uniqueIndex("playlist_target_user_provider_unique").on(table.userId, table.provider)],
);

export const playlistExports = pgTable(
  "playlist_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    playlistTargetId: uuid("playlist_target_id")
      .notNull()
      .references(() => playlistTargets.id, { onDelete: "cascade" }),
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    providerTrackId: text("provider_track_id").notNull(),
    status: exportStatusEnum("status").notNull().default("pending"),
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    errorCode: text("error_code"),
    appOwned: boolean("app_owned").notNull().default(true),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("playlist_export_target_provider_track_unique").on(
      table.playlistTargetId,
      table.providerTrackId,
    ),
    index("playlist_export_track_status_idx").on(table.trackId, table.status),
  ],
);

export const providerCache = pgTable(
  "provider_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: providerEnum("provider").notNull(),
    cacheKey: text("cache_key").notNull(),
    value: jsonb("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [uniqueIndex("provider_cache_key_unique").on(table.provider, table.cacheKey)],
);

export const providerCursors = pgTable(
  "provider_cursors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: providerEnum("provider").notNull(),
    cursorScope: text("cursor_scope").notNull(),
    scopeId: text("scope_id").notNull(),
    cursorValue: text("cursor_value").notNull(),
    updatedAt,
  },
  (table) => [
    uniqueIndex("provider_cursor_scope_unique").on(
      table.provider,
      table.cursorScope,
      table.scopeId,
    ),
  ],
);

export const manualMatchDecisions = pgTable(
  "manual_match_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => releaseCandidates.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    decision: text("decision").notNull(),
    selectedTrackId: uuid("selected_track_id").references(() => tracks.id, {
      onDelete: "set null",
    }),
    reason: text("reason").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("manual_match_candidate_unique").on(table.candidateId)],
);

export const redditSources = pgTable(
  "reddit_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    subreddit: text("subreddit").notNull(),
    displayName: text("display_name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    initialBackfillDays: integer("initial_backfill_days").notNull().default(14),
    scanOverlapHours: integer("scan_overlap_hours").notNull().default(72),
    maxPagesPerScan: integer("max_pages_per_scan").notNull().default(10),
    flairBoosts: text("flair_boosts")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    flairExclusions: text("flair_exclusions")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    roundupTitlePhrases: text("roundup_title_phrases")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    notes: text("notes"),
    lastSuccessfulScanAt: timestamp("last_successful_scan_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastSeenFullname: text("last_seen_fullname"),
    lastSeenCreatedAt: timestamp("last_seen_created_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    check(
      "reddit_sources_subreddit_format_check",
      sql`${table.subreddit} ~ '^[A-Za-z0-9_]{3,21}$'`,
    ),
    check(
      "reddit_sources_scan_limits_check",
      sql`${table.initialBackfillDays} between 1 and 365 and ${table.scanOverlapHours} between 1 and 720 and ${table.maxPagesPerScan} between 1 and 100`,
    ),
    uniqueIndex("reddit_sources_user_subreddit_unique").on(
      table.userId,
      sql`lower(${table.subreddit})`,
    ),
  ],
);

export const redditSubmissions = pgTable(
  "reddit_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => redditSources.id, { onDelete: "cascade" }),
    fullname: text("fullname").notNull(),
    redditPostId: text("reddit_post_id").notNull(),
    subreddit: text("subreddit").notNull(),
    permalink: text("permalink"),
    title: text("title"),
    selfText: text("self_text"),
    flairText: text("flair_text"),
    postType: text("post_type").notNull(),
    isSelfPost: boolean("is_self_post").notNull(),
    destinationUrl: text("destination_url"),
    crosspostOriginFullname: text("crosspost_origin_fullname"),
    redditCreatedAt: timestamp("reddit_created_at", { withTimezone: true }).notNull(),
    redditEditedAt: timestamp("reddit_edited_at", { withTimezone: true }),
    sourceState: text("source_state").notNull().default("active"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("reddit_submissions_fullname_unique").on(table.fullname),
    index("reddit_submissions_reconciliation_idx").on(table.sourceState, table.lastCheckedAt),
    index("reddit_submissions_source_created_idx").on(table.sourceId, table.redditCreatedAt),
  ],
);

export const redditParseResults = pgTable(
  "reddit_parse_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => redditSubmissions.id, { onDelete: "cascade" }),
    parserVersion: text("parser_version").notNull(),
    candidateHash: text("candidate_hash").notNull(),
    sourceLine: integer("source_line").notNull().default(0),
    sectionHeading: text("section_heading"),
    candidateArtistText: text("candidate_artist_text").notNull(),
    candidateTitleText: text("candidate_title_text").notNull(),
    candidateReleaseType: text("candidate_release_type").notNull(),
    candidateVersion: text("candidate_version"),
    candidateLabel: text("candidate_label"),
    claimedReleaseDate: date("claimed_release_date"),
    dateSourceText: text("date_source_text"),
    dateConfidence: text("date_confidence"),
    parseConfidence: numeric("parse_confidence", { precision: 4, scale: 3 }).notNull(),
    parseReasons: text("parse_reasons").array().notNull(),
    failureReasons: text("failure_reasons").array().notNull(),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("reddit_parse_submission_line_candidate_unique").on(
      table.submissionId,
      table.sourceLine,
      table.candidateHash,
    ),
  ],
);

export const redditCandidateMatches = pgTable(
  "reddit_candidate_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parseResultId: uuid("parse_result_id")
      .notNull()
      .references(() => redditParseResults.id, { onDelete: "cascade" }),
    canonicalArtistId: uuid("canonical_artist_id").references(() => artists.id, {
      onDelete: "set null",
    }),
    canonicalReleaseId: uuid("canonical_release_id").references(() => releases.id, {
      onDelete: "set null",
    }),
    canonicalTrackId: uuid("canonical_track_id").references(() => tracks.id, {
      onDelete: "set null",
    }),
    releaseCandidateId: uuid("release_candidate_id").references(() => releaseCandidates.id, {
      onDelete: "set null",
    }),
    matchConfidence: numeric("match_confidence", { precision: 4, scale: 3 }).notNull(),
    matchReasons: text("match_reasons").array().notNull(),
    reviewStatus: text("review_status").notNull().default("needs_review"),
    spotifyEvidence: jsonb("spotify_evidence")
      .notNull()
      .default(sql`'{}'::jsonb`),
    musicbrainzEvidence: jsonb("musicbrainz_evidence")
      .notNull()
      .default(sql`'{}'::jsonb`),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => [uniqueIndex("reddit_candidate_match_parse_unique").on(table.parseResultId)],
);

export const redditExternalLinks = pgTable(
  "reddit_external_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => redditSubmissions.id, { onDelete: "cascade" }),
    parseResultId: uuid("parse_result_id").references(() => redditParseResults.id, {
      onDelete: "cascade",
    }),
    category: text("category").notNull(),
    originalUrl: text("original_url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    detectedHost: text("detected_host").notNull(),
    verificationStatus: text("verification_status").notNull().default("reddit_supplied_unverified"),
    verifiedBy: uuid("verified_by").references(() => users.id, { onDelete: "set null" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("reddit_external_link_submission_url_unique").on(
      table.submissionId,
      table.normalizedUrl,
    ),
  ],
);

export const redditReconciliationRuns = pgTable("reddit_reconciliation_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  checkedCount: integer("checked_count").notNull().default(0),
  deletedCount: integer("deleted_count").notNull().default(0),
  preservedCanonicalCount: integer("preserved_canonical_count").notNull().default(0),
  status: text("status").notNull().default("running"),
  errorSummary: text("error_summary"),
});

export const applicationMetadata = pgTable("application_metadata", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt,
});
