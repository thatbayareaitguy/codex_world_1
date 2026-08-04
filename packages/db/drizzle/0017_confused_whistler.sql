CREATE TYPE "public"."apple_music_artist_scan_status" AS ENUM('pending', 'running', 'completed', 'retryable', 'terminal');--> statement-breakpoint
CREATE TYPE "public"."apple_music_batch_status" AS ENUM('pending', 'running', 'completed', 'partial', 'paused', 'rate_limited', 'failed');--> statement-breakpoint
CREATE TABLE "apple_music_artist_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"artist_id" uuid NOT NULL,
	"provider_artist_id" text NOT NULL,
	"position" integer NOT NULL,
	"status" "apple_music_artist_scan_status" DEFAULT 'pending' NOT NULL,
	"window_start" date NOT NULL,
	"window_end" date NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"request_count" integer DEFAULT 0 NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"release_count" integer DEFAULT 0 NOT NULL,
	"error_classification" text,
	"retry_eligible_at" timestamp with time zone,
	"last_persisted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apple_music_artist_state" (
	"artist_id" uuid PRIMARY KEY NOT NULL,
	"provider_artist_id" text NOT NULL,
	"last_successful_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_status" text DEFAULT 'never_scanned' NOT NULL,
	"error_classification" text,
	"retry_eligible_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apple_music_provider_state" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"next_request_at" timestamp with time zone,
	"last_request_started_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"queue_depth" integer DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"cooldown_until" timestamp with time zone,
	"cooldown_indefinite" boolean DEFAULT false NOT NULL,
	"cooldown_observed_at" timestamp with time zone,
	"cooldown_error_classification" text,
	"retry_after_seconds" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apple_music_request_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scan_run_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"endpoint_category" text NOT NULL,
	"request_identity" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"status" integer,
	"response_bytes" integer DEFAULT 0 NOT NULL,
	"retry_after_seconds" integer,
	"cooldown_until" timestamp with time zone,
	"error_classification" text,
	"cache_hit" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apple_music_response_cache" (
	"request_identity" text PRIMARY KEY NOT NULL,
	"response" jsonb NOT NULL,
	"response_hash" text NOT NULL,
	"stored_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apple_music_scan_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_run_id" uuid,
	"status" "apple_music_batch_status" DEFAULT 'pending' NOT NULL,
	"total_artists" integer NOT NULL,
	"completed_artists" integer DEFAULT 0 NOT NULL,
	"failed_artists" integer DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"window_days" integer DEFAULT 30 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artist_mapping_reviews" ALTER COLUMN "proposed_external_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "apple_music_artist_scans" ADD CONSTRAINT "apple_music_artist_scans_batch_id_apple_music_scan_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."apple_music_scan_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_music_artist_scans" ADD CONSTRAINT "apple_music_artist_scans_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_music_artist_state" ADD CONSTRAINT "apple_music_artist_state_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_music_request_events" ADD CONSTRAINT "apple_music_request_events_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_music_request_events" ADD CONSTRAINT "apple_music_request_events_batch_id_apple_music_scan_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."apple_music_scan_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_music_scan_batches" ADD CONSTRAINT "apple_music_scan_batches_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "apple_music_artist_scans_batch_artist_unique" ON "apple_music_artist_scans" USING btree ("batch_id","artist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "apple_music_artist_scans_batch_position_unique" ON "apple_music_artist_scans" USING btree ("batch_id","position");--> statement-breakpoint
CREATE INDEX "apple_music_artist_scans_status_idx" ON "apple_music_artist_scans" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "apple_music_request_events_run_started_idx" ON "apple_music_request_events" USING btree ("scan_run_id","started_at");--> statement-breakpoint
CREATE INDEX "apple_music_request_events_batch_started_idx" ON "apple_music_request_events" USING btree ("batch_id","started_at");--> statement-breakpoint
CREATE INDEX "apple_music_scan_batches_status_idx" ON "apple_music_scan_batches" USING btree ("status","created_at");