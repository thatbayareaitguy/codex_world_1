import { sql } from "drizzle-orm";
import {
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
export const scanStatusEnum = pgEnum("scan_status", ["running", "completed", "partial", "failed"]);
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
  ],
);

export const scanRuns = pgTable("scan_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: providerEnum("provider"),
  status: scanStatusEnum("status").notNull().default("running"),
  dryRun: boolean("dry_run").notNull().default(false),
  artistFilter: text("artist_filter"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  discoveredCount: integer("discovered_count").notNull().default(0),
  insertedCount: integer("inserted_count").notNull().default(0),
  updatedCount: integer("updated_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  reviewCount: integer("review_count").notNull().default(0),
  playlistAdditionCount: integer("playlist_addition_count").notNull().default(0),
  providerResults: jsonb("provider_results")
    .notNull()
    .default(sql`'{}'::jsonb`),
  metadata: jsonb("metadata")
    .notNull()
    .default(sql`'{}'::jsonb`),
  errors: jsonb("errors")
    .notNull()
    .default(sql`'[]'::jsonb`),
});

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
    index("feed_user_state_seen_idx").on(table.userId, table.state, table.firstSeenAt),
  ],
);

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
