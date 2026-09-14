CREATE TYPE "public"."musicbrainz_artist_scan_status" AS ENUM('pending', 'running', 'completed', 'paused', 'cancelled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."musicbrainz_batch_status" AS ENUM('pending', 'running', 'completed', 'paused', 'cancelled', 'failed');--> statement-breakpoint
CREATE TABLE "musicbrainz_artist_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"artist_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"status" "musicbrainz_artist_scan_status" DEFAULT 'pending' NOT NULL,
	"stage" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"request_count" integer DEFAULT 0 NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"release_group_count" integer DEFAULT 0 NOT NULL,
	"release_count" integer DEFAULT 0 NOT NULL,
	"error_classification" text,
	"last_persisted_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "musicbrainz_provider_state" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"next_request_at" timestamp with time zone,
	"last_request_started_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"queue_depth" integer DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "musicbrainz_request_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_category" text NOT NULL,
	"method" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"status" integer,
	"queue_wait_ms" integer DEFAULT 0 NOT NULL,
	"retry_attempt" integer DEFAULT 1 NOT NULL,
	"error_classification" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "musicbrainz_scan_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_run_id" uuid,
	"status" "musicbrainz_batch_status" DEFAULT 'pending' NOT NULL,
	"total_artists" integer NOT NULL,
	"completed_artists" integer DEFAULT 0 NOT NULL,
	"failed_artists" integer DEFAULT 0 NOT NULL,
	"cancelled_artists" integer DEFAULT 0 NOT NULL,
	"pause_requested" boolean DEFAULT false NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "musicbrainz_artist_scans" ADD CONSTRAINT "musicbrainz_artist_scans_batch_id_musicbrainz_scan_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."musicbrainz_scan_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "musicbrainz_artist_scans" ADD CONSTRAINT "musicbrainz_artist_scans_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "musicbrainz_scan_batches" ADD CONSTRAINT "musicbrainz_scan_batches_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "musicbrainz_artist_scans_batch_artist_unique" ON "musicbrainz_artist_scans" USING btree ("batch_id","artist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "musicbrainz_artist_scans_batch_position_unique" ON "musicbrainz_artist_scans" USING btree ("batch_id","position");--> statement-breakpoint
CREATE INDEX "musicbrainz_artist_scans_status_idx" ON "musicbrainz_artist_scans" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "musicbrainz_request_events_started_idx" ON "musicbrainz_request_events" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "musicbrainz_scan_batches_status_idx" ON "musicbrainz_scan_batches" USING btree ("status","created_at");