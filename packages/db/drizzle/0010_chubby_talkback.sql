CREATE TABLE "spotify_artist_coverage" (
	"artist_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'reconciliation_queued' NOT NULL,
	"daily_scan_completed_at" timestamp with time zone,
	"reconciliation_started_at" timestamp with time zone,
	"reconciliation_completed_at" timestamp with time zone,
	"next_offset" integer DEFAULT 0 NOT NULL,
	"pages_scanned_in_cycle" integer DEFAULT 0 NOT NULL,
	"catalog_pages_completed" integer DEFAULT 0 NOT NULL,
	"estimated_total_pages" integer,
	"partial" boolean DEFAULT true NOT NULL,
	"last_page_scanned_at" timestamp with time zone,
	"last_full_reconciliation_at" timestamp with time zone,
	"last_reconciliation_error" text,
	"reconciliation_cycle_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spotify_catalog_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artist_id" uuid NOT NULL,
	"external_release_id" text NOT NULL,
	"title" text NOT NULL,
	"release_date" date NOT NULL,
	"release_date_precision" text NOT NULL,
	"release_type" text NOT NULL,
	"total_tracks" integer NOT NULL,
	"summary_hash" text NOT NULL,
	"first_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"details_fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spotify_page_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"artist_scan_id" uuid NOT NULL,
	"artist_id" uuid NOT NULL,
	"reconciliation_cycle_id" uuid,
	"mode" text NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"page_number" integer NOT NULL,
	"spotify_offset" integer NOT NULL,
	"item_count" integer NOT NULL,
	"total_items" integer NOT NULL,
	"next_offset" integer,
	"another_page" boolean NOT NULL,
	"backfill_release_count" integer DEFAULT 0 NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"album_detail_requests" integer DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spotify_artist_coverage" ADD CONSTRAINT "spotify_artist_coverage_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spotify_catalog_releases" ADD CONSTRAINT "spotify_catalog_releases_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spotify_page_scans" ADD CONSTRAINT "spotify_page_scans_batch_id_spotify_scan_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."spotify_scan_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spotify_page_scans" ADD CONSTRAINT "spotify_page_scans_artist_scan_id_spotify_artist_scans_id_fk" FOREIGN KEY ("artist_scan_id") REFERENCES "public"."spotify_artist_scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spotify_page_scans" ADD CONSTRAINT "spotify_page_scans_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spotify_artist_coverage_status_idx" ON "spotify_artist_coverage" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "spotify_catalog_releases_artist_release_unique" ON "spotify_catalog_releases" USING btree ("artist_id","external_release_id");--> statement-breakpoint
CREATE INDEX "spotify_catalog_releases_observed_idx" ON "spotify_catalog_releases" USING btree ("artist_id","last_observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "spotify_page_scans_artist_offset_unique" ON "spotify_page_scans" USING btree ("artist_scan_id","spotify_offset");--> statement-breakpoint
CREATE INDEX "spotify_page_scans_cycle_idx" ON "spotify_page_scans" USING btree ("artist_id","reconciliation_cycle_id");
--> statement-breakpoint
WITH latest AS (
	SELECT DISTINCT ON ("artist_id")
		"artist_id",
		"status",
		"pages_scanned",
		"finished_at"
	FROM "spotify_artist_scans"
	WHERE "status" IN ('completed', 'partial')
	ORDER BY "artist_id", "finished_at" DESC NULLS LAST, "created_at" DESC
)
INSERT INTO "spotify_artist_coverage" (
	"artist_id",
	"status",
	"daily_scan_completed_at",
	"next_offset",
	"pages_scanned_in_cycle",
	"catalog_pages_completed",
	"partial",
	"last_page_scanned_at",
	"last_full_reconciliation_at",
	"reconciliation_cycle_id"
)
SELECT
	"artist_id",
	CASE WHEN "status" = 'partial' THEN 'reconciliation_queued' ELSE 'fully_reconciled' END,
	"finished_at",
	CASE WHEN "status" = 'partial' THEN greatest("pages_scanned", 0) * 10 ELSE 0 END,
	greatest("pages_scanned", 0),
	greatest("pages_scanned", 0),
	"status" = 'partial',
	"finished_at",
	CASE WHEN "status" = 'completed' THEN "finished_at" ELSE NULL END,
	CASE WHEN "status" = 'partial' THEN gen_random_uuid() ELSE NULL END
FROM latest
ON CONFLICT ("artist_id") DO NOTHING;
