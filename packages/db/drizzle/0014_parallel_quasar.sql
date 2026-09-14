CREATE TYPE "public"."spotify_scheduler_mode" AS ENUM('disabled', 'planning', 'validation', 'automatic', 'paused');--> statement-breakpoint
CREATE TYPE "public"."spotify_scheduler_work_source" AS ENUM('initial', 'recurring', 'validation', 'repair');--> statement-breakpoint
CREATE TYPE "public"."spotify_scheduler_work_status" AS ENUM('queued', 'leased', 'blocked', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."spotify_scheduler_work_type" AS ENUM('base_artist', 'release_detail', 'release_tracks', 'artist_reconciliation');--> statement-breakpoint
CREATE TABLE "spotify_scheduler_state" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"mode" "spotify_scheduler_mode" DEFAULT 'disabled' NOT NULL,
	"next_base_slot_at" timestamp with time zone,
	"cycle_started_at" timestamp with time zone,
	"cycle_target_artists" integer DEFAULT 0 NOT NULL,
	"last_tick_started_at" timestamp with time zone,
	"last_tick_completed_at" timestamp with time zone,
	"last_tick_error_classification" text,
	"effective_configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spotify_scheduler_work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_key" text NOT NULL,
	"work_type" "spotify_scheduler_work_type" NOT NULL,
	"status" "spotify_scheduler_work_status" DEFAULT 'queued' NOT NULL,
	"source" "spotify_scheduler_work_source" NOT NULL,
	"artist_id" uuid,
	"expected_spotify_artist_id" text,
	"spotify_album_id" text,
	"release_track_retrieval_id" uuid,
	"reconciliation_cycle_id" uuid,
	"priority" integer DEFAULT 100 NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"not_before" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_classification" text,
	"blocked_reason" text,
	"last_started_at" timestamp with time zone,
	"last_completed_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spotify_scheduler_work_target_check" CHECK ((
        ("spotify_scheduler_work"."work_type" in ('base_artist', 'artist_reconciliation') and "spotify_scheduler_work"."artist_id" is not null and "spotify_scheduler_work"."expected_spotify_artist_id" is not null)
        or ("spotify_scheduler_work"."work_type" = 'release_detail' and "spotify_scheduler_work"."spotify_album_id" is not null)
        or ("spotify_scheduler_work"."work_type" = 'release_tracks' and "spotify_scheduler_work"."spotify_album_id" is not null and "spotify_scheduler_work"."release_track_retrieval_id" is not null)
      )),
	CONSTRAINT "spotify_scheduler_work_lease_check" CHECK (("spotify_scheduler_work"."status" = 'leased' and "spotify_scheduler_work"."lease_owner" is not null and "spotify_scheduler_work"."lease_expires_at" is not null) or ("spotify_scheduler_work"."status" <> 'leased' and "spotify_scheduler_work"."lease_owner" is null and "spotify_scheduler_work"."lease_expires_at" is null))
);
--> statement-breakpoint
ALTER TABLE "spotify_request_events" ADD COLUMN "scheduler_work_id" uuid;--> statement-breakpoint
ALTER TABLE "spotify_request_events" ADD COLUMN "scheduler_work_type" "spotify_scheduler_work_type";--> statement-breakpoint
ALTER TABLE "spotify_scheduler_work" ADD CONSTRAINT "spotify_scheduler_work_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spotify_scheduler_work" ADD CONSTRAINT "spotify_scheduler_work_release_track_retrieval_id_spotify_release_track_retrievals_id_fk" FOREIGN KEY ("release_track_retrieval_id") REFERENCES "public"."spotify_release_track_retrievals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "spotify_scheduler_work_key_unique" ON "spotify_scheduler_work" USING btree ("work_key");--> statement-breakpoint
CREATE INDEX "spotify_scheduler_work_due_idx" ON "spotify_scheduler_work" USING btree ("status","due_at","priority","id");--> statement-breakpoint
CREATE INDEX "spotify_scheduler_work_type_due_idx" ON "spotify_scheduler_work" USING btree ("work_type","status","due_at","id");--> statement-breakpoint
CREATE INDEX "spotify_scheduler_work_lease_idx" ON "spotify_scheduler_work" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE INDEX "spotify_scheduler_work_artist_idx" ON "spotify_scheduler_work" USING btree ("artist_id","status");--> statement-breakpoint
CREATE INDEX "spotify_scheduler_work_album_idx" ON "spotify_scheduler_work" USING btree ("spotify_album_id","work_type");--> statement-breakpoint
CREATE INDEX "spotify_request_events_scheduler_idx" ON "spotify_request_events" USING btree ("scheduler_work_type","started_at");--> statement-breakpoint
INSERT INTO "spotify_scheduler_state" (
	"id",
	"mode",
	"next_base_slot_at",
	"cycle_started_at",
	"cycle_target_artists",
	"effective_configuration"
)
SELECT
	'global',
	'disabled',
	now(),
	now(),
	count(DISTINCT "artist_follows"."artist_id")::integer,
	'{"maxArtistsPerTick":1,"maxRequestsPerTick":6,"maxRuntimeMs":90000,"minRequestIntervalMs":10000,"windowHours":24}'::jsonb
FROM "artist_follows"
INNER JOIN "artist_external_ids"
	ON "artist_external_ids"."artist_id" = "artist_follows"."artist_id"
	AND "artist_external_ids"."provider" = 'spotify'
	AND "artist_external_ids"."confirmed" = true
WHERE "artist_follows"."active" = true
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
WITH eligible AS (
	SELECT
		"artist_follows"."artist_id",
		min("artist_follows"."followed_at") AS "followed_at",
		min("artist_external_ids"."external_id") AS "spotify_artist_id",
		max("spotify_artist_coverage"."daily_scan_completed_at") AS "coverage_completed_at",
		(
			SELECT max("spotify_artist_scans"."finished_at")
			FROM "spotify_artist_scans"
			WHERE "spotify_artist_scans"."artist_id" = "artist_follows"."artist_id"
				AND "spotify_artist_scans"."status" IN ('completed', 'partial')
		) AS "scan_completed_at"
	FROM "artist_follows"
	INNER JOIN "artist_external_ids"
		ON "artist_external_ids"."artist_id" = "artist_follows"."artist_id"
		AND "artist_external_ids"."provider" = 'spotify'
		AND "artist_external_ids"."confirmed" = true
	LEFT JOIN "spotify_artist_coverage"
		ON "spotify_artist_coverage"."artist_id" = "artist_follows"."artist_id"
	WHERE "artist_follows"."active" = true
	GROUP BY "artist_follows"."artist_id"
), ranked AS (
	SELECT
		*,
		row_number() OVER (
			PARTITION BY (coalesce("coverage_completed_at", "scan_completed_at") IS NULL)
			ORDER BY "followed_at", "artist_id"
		) AS "stable_rank",
		count(*) FILTER (
			WHERE coalesce("coverage_completed_at", "scan_completed_at") IS NULL
		) OVER () AS "never_count"
	FROM eligible
)
INSERT INTO "spotify_scheduler_work" (
	"work_key",
	"work_type",
	"status",
	"source",
	"artist_id",
	"expected_spotify_artist_id",
	"priority",
	"due_at"
)
SELECT
	'base_artist:' || "artist_id"::text,
	'base_artist',
	'queued',
	CASE
		WHEN coalesce("coverage_completed_at", "scan_completed_at") IS NULL THEN 'initial'::"spotify_scheduler_work_source"
		ELSE 'recurring'::"spotify_scheduler_work_source"
	END,
	"artist_id",
	"spotify_artist_id",
	10,
	CASE
		WHEN coalesce("coverage_completed_at", "scan_completed_at") IS NOT NULL
			THEN coalesce("coverage_completed_at", "scan_completed_at") + interval '24 hours'
		ELSE now() + (("stable_rank" - 1) * interval '24 hours' / greatest("never_count", 1))
	END
FROM ranked
ON CONFLICT ("work_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "spotify_scheduler_work" (
	"work_key",
	"work_type",
	"status",
	"source",
	"artist_id",
	"expected_spotify_artist_id",
	"reconciliation_cycle_id",
	"priority",
	"due_at"
)
SELECT
	'artist_reconciliation:' || "spotify_artist_coverage"."artist_id"::text,
	'artist_reconciliation',
	'queued',
	'recurring',
	"spotify_artist_coverage"."artist_id",
	"artist_external_ids"."external_id",
	"spotify_artist_coverage"."reconciliation_cycle_id",
	400,
	coalesce("spotify_artist_coverage"."updated_at", now())
FROM "spotify_artist_coverage"
INNER JOIN "artist_follows"
	ON "artist_follows"."artist_id" = "spotify_artist_coverage"."artist_id"
	AND "artist_follows"."active" = true
INNER JOIN "artist_external_ids"
	ON "artist_external_ids"."artist_id" = "spotify_artist_coverage"."artist_id"
	AND "artist_external_ids"."provider" = 'spotify'
	AND "artist_external_ids"."confirmed" = true
WHERE "spotify_artist_coverage"."partial" = true
ON CONFLICT ("work_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "spotify_scheduler_work" (
	"work_key",
	"work_type",
	"status",
	"source",
	"spotify_album_id",
	"release_track_retrieval_id",
	"priority",
	"due_at"
)
SELECT
	'release_tracks:' || "id"::text,
	'release_tracks',
	'queued',
	'repair',
	"spotify_album_id",
	"id",
	20,
	coalesce("retry_eligible_at", "updated_at")
FROM "spotify_release_track_retrievals"
WHERE "status" <> 'completed'
ON CONFLICT ("work_key") DO NOTHING;
