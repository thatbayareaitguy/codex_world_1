CREATE TYPE "public"."spotify_release_track_status" AS ENUM('not_started', 'in_progress', 'partial', 'completed', 'paused', 'rate_limited', 'failed');--> statement-breakpoint
ALTER TYPE "public"."spotify_artist_scan_status" ADD VALUE 'blocked_mapping' BEFORE 'failed';--> statement-breakpoint
ALTER TYPE "public"."spotify_batch_status" ADD VALUE 'blocked_mapping' BEFORE 'failed';--> statement-breakpoint
CREATE TABLE "release_track_appearance_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"appearance_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"provider" "provider" NOT NULL,
	"provider_release_id" text NOT NULL,
	"provider_track_id" text NOT NULL,
	"observed_credit" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_track_appearances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid NOT NULL,
	"track_id" uuid NOT NULL,
	"disc_number" integer DEFAULT 1 NOT NULL,
	"track_number" integer DEFAULT 1 NOT NULL,
	"provider_order" integer,
	"presentation_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spotify_release_track_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"retrieval_id" uuid NOT NULL,
	"provider_track_id" text NOT NULL,
	"page_offset" integer NOT NULL,
	"disc_number" integer NOT NULL,
	"track_number" integer NOT NULL,
	"first_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spotify_release_track_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"retrieval_id" uuid NOT NULL,
	"offset" integer NOT NULL,
	"item_count" integer NOT NULL,
	"unique_item_count" integer NOT NULL,
	"next_offset" integer,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spotify_release_track_retrievals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid,
	"spotify_album_id" text NOT NULL,
	"expected_total_tracks" integer NOT NULL,
	"fetched_track_count" integer DEFAULT 0 NOT NULL,
	"next_offset" integer,
	"pages_completed" integer DEFAULT 0 NOT NULL,
	"status" "spotify_release_track_status" DEFAULT 'not_started' NOT NULL,
	"started_at" timestamp with time zone,
	"last_page_completed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_error_classification" text,
	"retry_eligible_at" timestamp with time zone,
	"discrepancy" text,
	"reconciliation_cycle_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "feed_user_track_unique";--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "appearance_id" uuid;--> statement-breakpoint
ALTER TABLE "spotify_artist_scans" ADD COLUMN "provider_artist_id" text;--> statement-breakpoint
ALTER TABLE "spotify_scan_batches" ADD COLUMN "blocked_mapping_artists" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "release_track_appearance_sources" ADD CONSTRAINT "release_track_appearance_sources_appearance_id_release_track_appearances_id_fk" FOREIGN KEY ("appearance_id") REFERENCES "public"."release_track_appearances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_track_appearance_sources" ADD CONSTRAINT "release_track_appearance_sources_candidate_id_release_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."release_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_track_appearances" ADD CONSTRAINT "release_track_appearances_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_track_appearances" ADD CONSTRAINT "release_track_appearances_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spotify_release_track_items" ADD CONSTRAINT "spotify_release_track_items_retrieval_id_spotify_release_track_retrievals_id_fk" FOREIGN KEY ("retrieval_id") REFERENCES "public"."spotify_release_track_retrievals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spotify_release_track_pages" ADD CONSTRAINT "spotify_release_track_pages_retrieval_id_spotify_release_track_retrievals_id_fk" FOREIGN KEY ("retrieval_id") REFERENCES "public"."spotify_release_track_retrievals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spotify_release_track_retrievals" ADD CONSTRAINT "spotify_release_track_retrievals_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Build canonical releases for provider releases whose preserved candidate provenance
-- proves that the old single track.release_id association pointed at a different release.
INSERT INTO "releases" (
	"title",
	"normalized_title",
	"release_type",
	"release_date",
	"release_date_precision"
)
SELECT DISTINCT ON (
	lower(candidate."raw_payload"->>'releaseTitle'),
	candidate."release_date",
	(candidate."raw_payload"->>'releaseType')::"release_type"
)
	candidate."raw_payload"->>'releaseTitle',
	lower(regexp_replace(candidate."raw_payload"->>'releaseTitle', '[^[:alnum:]]+', ' ', 'g')),
	(candidate."raw_payload"->>'releaseType')::"release_type",
	candidate."release_date",
	COALESCE(candidate."raw_payload"->>'releaseDatePrecision', 'day')
FROM "release_candidates" candidate
LEFT JOIN "release_external_ids" external_release
	ON external_release."provider" = candidate."provider"
	AND external_release."external_id" = candidate."provider_release_id"
LEFT JOIN "releases" mapped_release ON mapped_release."id" = external_release."release_id"
WHERE candidate."matched_track_id" IS NOT NULL
	AND candidate."match_status" IN ('new', 'matched')
	AND candidate."raw_payload"->>'releaseTitle' IS NOT NULL
	AND candidate."raw_payload"->>'releaseType' IS NOT NULL
	AND (
		mapped_release."id" IS NULL
		OR lower(mapped_release."title") <> lower(candidate."raw_payload"->>'releaseTitle')
		OR mapped_release."release_date" <> candidate."release_date"
	)
	AND NOT EXISTS (
		SELECT 1
		FROM "releases" exact_release
		WHERE lower(exact_release."title") = lower(candidate."raw_payload"->>'releaseTitle')
			AND exact_release."release_date" = candidate."release_date"
			AND exact_release."release_type" = (candidate."raw_payload"->>'releaseType')::"release_type"
	);--> statement-breakpoint
INSERT INTO "release_external_ids" (
	"release_id",
	"provider",
	"external_id",
	"provider_url",
	"provider_fields"
)
SELECT DISTINCT ON (candidate."provider", candidate."provider_release_id")
	exact_release."id",
	candidate."provider",
	candidate."provider_release_id",
	'https://open.spotify.com/album/' || candidate."provider_release_id",
	jsonb_build_object('repairedFromCandidateId', candidate."id")
FROM "release_candidates" candidate
JOIN LATERAL (
	SELECT release."id"
	FROM "releases" release
	WHERE lower(release."title") = lower(candidate."raw_payload"->>'releaseTitle')
		AND release."release_date" = candidate."release_date"
		AND release."release_type" = (candidate."raw_payload"->>'releaseType')::"release_type"
	ORDER BY release."created_at", release."id"
	LIMIT 1
) exact_release ON true
WHERE candidate."provider" = 'spotify'
	AND candidate."matched_track_id" IS NOT NULL
	AND candidate."match_status" IN ('new', 'matched')
	AND candidate."provider_release_id" IS NOT NULL
	AND candidate."raw_payload"->>'releaseTitle' IS NOT NULL
	AND candidate."raw_payload"->>'releaseType' IS NOT NULL
	AND NOT EXISTS (
		SELECT 1
		FROM "release_external_ids" existing
		WHERE existing."provider" = candidate."provider"
			AND existing."external_id" = candidate."provider_release_id"
	)
ORDER BY candidate."provider", candidate."provider_release_id", candidate."first_seen_at";--> statement-breakpoint
UPDATE "release_external_ids" external_release
SET "release_id" = exact_release."id", "updated_at" = now()
FROM "release_candidates" candidate
JOIN LATERAL (
	SELECT release."id"
	FROM "releases" release
	WHERE lower(release."title") = lower(candidate."raw_payload"->>'releaseTitle')
		AND release."release_date" = candidate."release_date"
		AND release."release_type" = (candidate."raw_payload"->>'releaseType')::"release_type"
	ORDER BY release."created_at", release."id"
	LIMIT 1
) exact_release ON true
WHERE external_release."provider" = candidate."provider"
	AND external_release."external_id" = candidate."provider_release_id"
	AND candidate."matched_track_id" IS NOT NULL
	AND candidate."match_status" IN ('new', 'matched')
	AND candidate."raw_payload"->>'releaseTitle' IS NOT NULL
	AND external_release."release_id" <> exact_release."id";--> statement-breakpoint
INSERT INTO "release_track_appearances" (
	"release_id",
	"track_id",
	"disc_number",
	"track_number",
	"provider_order",
	"presentation_metadata",
	"first_observed_at",
	"last_observed_at"
)
SELECT DISTINCT ON (
	external_release."release_id",
	candidate."matched_track_id",
	COALESCE((candidate."raw_payload"->>'discNumber')::integer, 1),
	COALESCE((candidate."raw_payload"->>'trackNumber')::integer, 1)
)
	external_release."release_id",
	candidate."matched_track_id",
	COALESCE((candidate."raw_payload"->>'discNumber')::integer, 1),
	COALESCE((candidate."raw_payload"->>'trackNumber')::integer, 1),
	(candidate."raw_payload"->>'trackNumber')::integer,
	jsonb_build_object(
		'releaseTitle', candidate."raw_payload"->>'releaseTitle',
		'version', candidate."raw_payload"->>'version'
	),
	candidate."first_seen_at",
	candidate."first_seen_at"
FROM "release_candidates" candidate
JOIN "release_external_ids" external_release
	ON external_release."provider" = candidate."provider"
	AND external_release."external_id" = candidate."provider_release_id"
WHERE candidate."matched_track_id" IS NOT NULL
	AND candidate."match_status" IN ('new', 'matched')
ORDER BY
	external_release."release_id",
	candidate."matched_track_id",
	COALESCE((candidate."raw_payload"->>'discNumber')::integer, 1),
	COALESCE((candidate."raw_payload"->>'trackNumber')::integer, 1),
	candidate."first_seen_at";--> statement-breakpoint
INSERT INTO "release_track_appearance_sources" (
	"appearance_id",
	"candidate_id",
	"provider",
	"provider_release_id",
	"provider_track_id",
	"observed_credit",
	"first_observed_at",
	"last_observed_at"
)
SELECT
	appearance."id",
	candidate."id",
	candidate."provider",
	candidate."provider_release_id",
	candidate."provider_track_id",
	COALESCE(candidate."raw_payload"->'credits', '[]'::jsonb),
	candidate."first_seen_at",
	candidate."first_seen_at"
FROM "release_candidates" candidate
JOIN "release_external_ids" external_release
	ON external_release."provider" = candidate."provider"
	AND external_release."external_id" = candidate."provider_release_id"
JOIN "release_track_appearances" appearance
	ON appearance."release_id" = external_release."release_id"
	AND appearance."track_id" = candidate."matched_track_id"
	AND appearance."disc_number" = COALESCE((candidate."raw_payload"->>'discNumber')::integer, 1)
	AND appearance."track_number" = COALESCE((candidate."raw_payload"->>'trackNumber')::integer, 1)
WHERE candidate."matched_track_id" IS NOT NULL
	AND candidate."match_status" IN ('new', 'matched');--> statement-breakpoint
UPDATE "feed_items" feed
SET
	"appearance_id" = source."appearance_id",
	"release_id" = appearance."release_id",
	"updated_at" = feed."updated_at"
FROM "release_track_appearance_sources" source
JOIN "release_track_appearances" appearance ON appearance."id" = source."appearance_id"
WHERE source."candidate_id" = feed."candidate_id";--> statement-breakpoint
INSERT INTO "feed_items" (
	"user_id",
	"candidate_id",
	"release_id",
	"track_id",
	"appearance_id",
	"state",
	"dedupe_key",
	"first_seen_at"
)
SELECT
	owner."id",
	candidate."id",
	appearance."release_id",
	appearance."track_id",
	appearance."id",
	'new'::"feed_state",
	candidate."provider"::text || ':' || candidate."provider_release_id" || ':' || candidate."provider_track_id",
	candidate."first_seen_at"
FROM "release_track_appearance_sources" source
JOIN "release_track_appearances" appearance ON appearance."id" = source."appearance_id"
JOIN "release_candidates" candidate ON candidate."id" = source."candidate_id"
CROSS JOIN LATERAL (SELECT "id" FROM "users" ORDER BY "created_at" LIMIT 1) owner
WHERE NOT EXISTS (
	SELECT 1 FROM "feed_items" existing WHERE existing."candidate_id" = candidate."id"
)
AND NOT EXISTS (
	SELECT 1
	FROM "feed_items" existing
	WHERE existing."user_id" = owner."id"
		AND existing."appearance_id" = appearance."id"
		AND existing."state" <> 'needs_review'
);--> statement-breakpoint
UPDATE "spotify_artist_scans" artist_scan
SET "provider_artist_id" = external_id."external_id"
FROM "artist_external_ids" external_id
WHERE external_id."artist_id" = artist_scan."artist_id"
	AND external_id."provider" = 'spotify'
	AND external_id."confirmed" = true
	AND artist_scan."provider_artist_id" IS NULL;--> statement-breakpoint
INSERT INTO "spotify_release_track_retrievals" (
	"release_id",
	"spotify_album_id",
	"expected_total_tracks",
	"fetched_track_count",
	"next_offset",
	"status",
	"discrepancy"
)
SELECT
	external_release."release_id",
	external_release."external_id",
	COALESCE(MAX(catalog."total_tracks"), count(DISTINCT candidate."provider_track_id")::integer),
	count(DISTINCT candidate."provider_track_id")::integer,
	0,
	'partial'::"spotify_release_track_status",
	'historical_scan_requires_reconciliation'
FROM "release_external_ids" external_release
JOIN "release_candidates" candidate
	ON candidate."provider" = 'spotify'
	AND candidate."provider_release_id" = external_release."external_id"
LEFT JOIN "spotify_catalog_releases" catalog
	ON catalog."external_release_id" = external_release."external_id"
WHERE external_release."provider" = 'spotify'
GROUP BY external_release."release_id", external_release."external_id";--> statement-breakpoint
CREATE UNIQUE INDEX "release_track_appearance_source_candidate_unique" ON "release_track_appearance_sources" USING btree ("candidate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "release_track_appearance_source_provider_unique" ON "release_track_appearance_sources" USING btree ("provider","provider_release_id","provider_track_id");--> statement-breakpoint
CREATE INDEX "release_track_appearance_source_appearance_idx" ON "release_track_appearance_sources" USING btree ("appearance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "release_track_appearance_identity_unique" ON "release_track_appearances" USING btree ("release_id","track_id","disc_number","track_number");--> statement-breakpoint
CREATE INDEX "release_track_appearance_release_order_idx" ON "release_track_appearances" USING btree ("release_id","disc_number","track_number");--> statement-breakpoint
CREATE INDEX "release_track_appearance_track_idx" ON "release_track_appearances" USING btree ("track_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spotify_release_track_items_retrieval_track_unique" ON "spotify_release_track_items" USING btree ("retrieval_id","provider_track_id");--> statement-breakpoint
CREATE INDEX "spotify_release_track_items_order_idx" ON "spotify_release_track_items" USING btree ("retrieval_id","disc_number","track_number");--> statement-breakpoint
CREATE UNIQUE INDEX "spotify_release_track_pages_retrieval_offset_unique" ON "spotify_release_track_pages" USING btree ("retrieval_id","offset");--> statement-breakpoint
CREATE UNIQUE INDEX "spotify_release_track_retrieval_album_unique" ON "spotify_release_track_retrievals" USING btree ("spotify_album_id");--> statement-breakpoint
CREATE INDEX "spotify_release_track_retrieval_status_idx" ON "spotify_release_track_retrievals" USING btree ("status","updated_at");--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_appearance_id_release_track_appearances_id_fk" FOREIGN KEY ("appearance_id") REFERENCES "public"."release_track_appearances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feed_user_appearance_unique" ON "feed_items" USING btree ("user_id","appearance_id") WHERE "feed_items"."appearance_id" is not null and "feed_items"."state" <> 'needs_review';
