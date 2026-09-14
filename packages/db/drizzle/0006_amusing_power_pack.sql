CREATE TYPE "public"."spotify_artist_scan_status" AS ENUM('pending', 'running', 'completed', 'partial', 'paused', 'cancelled', 'rate_limited', 'failed');--> statement-breakpoint
CREATE TYPE "public"."spotify_batch_status" AS ENUM('pending', 'running', 'completed', 'paused', 'cancelled', 'rate_limited', 'failed');--> statement-breakpoint
ALTER TYPE "public"."scan_status" ADD VALUE 'cancelled';--> statement-breakpoint
ALTER TYPE "public"."scan_status" ADD VALUE 'paused';--> statement-breakpoint
ALTER TYPE "public"."scan_status" ADD VALUE 'rate_limited';--> statement-breakpoint
CREATE TABLE "spotify_artist_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"artist_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"status" "spotify_artist_scan_status" DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"request_count" integer DEFAULT 0 NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"pages_scanned" integer DEFAULT 0 NOT NULL,
	"error_classification" text,
	"retry_eligible_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spotify_provider_state" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"cooldown_until" timestamp with time zone,
	"cooldown_indefinite" boolean DEFAULT false NOT NULL,
	"cooldown_observed_at" timestamp with time zone,
	"cooldown_endpoint_category" text,
	"cooldown_status" integer,
	"raw_retry_after" text,
	"parsed_retry_after_seconds" text,
	"cooldown_error_classification" text,
	"cooldown_response_classification" text,
	"next_request_at" timestamp with time zone,
	"last_request_started_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"queue_depth" integer DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"manual_clear_at" timestamp with time zone,
	"manual_clear_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spotify_request_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_category" text NOT NULL,
	"method" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"status" integer,
	"queue_wait_ms" integer DEFAULT 0 NOT NULL,
	"raw_retry_after" text,
	"parsed_retry_after_seconds" text,
	"cooldown_until" timestamp with time zone,
	"error_classification" text,
	"response_classification" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spotify_scan_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_run_id" uuid,
	"mode" text NOT NULL,
	"status" "spotify_batch_status" DEFAULT 'pending' NOT NULL,
	"page_limit" integer NOT NULL,
	"total_artists" integer NOT NULL,
	"completed_artists" integer DEFAULT 0 NOT NULL,
	"failed_artists" integer DEFAULT 0 NOT NULL,
	"partial_artists" integer DEFAULT 0 NOT NULL,
	"cancelled_artists" integer DEFAULT 0 NOT NULL,
	"rate_limited_artists" integer DEFAULT 0 NOT NULL,
	"estimated_requests" integer DEFAULT 0 NOT NULL,
	"pause_requested" boolean DEFAULT false NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"confirmation_required" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spotify_artist_scans" ADD CONSTRAINT "spotify_artist_scans_batch_id_spotify_scan_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."spotify_scan_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spotify_artist_scans" ADD CONSTRAINT "spotify_artist_scans_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spotify_scan_batches" ADD CONSTRAINT "spotify_scan_batches_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "spotify_artist_scans_batch_artist_unique" ON "spotify_artist_scans" USING btree ("batch_id","artist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spotify_artist_scans_batch_position_unique" ON "spotify_artist_scans" USING btree ("batch_id","position");--> statement-breakpoint
CREATE INDEX "spotify_artist_scans_status_idx" ON "spotify_artist_scans" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "spotify_request_events_started_idx" ON "spotify_request_events" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "spotify_scan_batches_status_idx" ON "spotify_scan_batches" USING btree ("status","created_at");
