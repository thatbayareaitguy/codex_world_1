CREATE TYPE "public"."spotify_playlist_export_action" AS ENUM('add', 'already_present', 'skip');--> statement-breakpoint
CREATE TYPE "public"."spotify_playlist_export_run_status" AS ENUM('planned', 'running', 'partial', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "spotify_playlist_export_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"feed_item_id" uuid,
	"track_id" uuid,
	"provider_track_id" text,
	"action" "spotify_playlist_export_action" NOT NULL,
	"status" "export_status" DEFAULT 'pending' NOT NULL,
	"desired_ordinal" integer,
	"insert_position" integer,
	"reason" text NOT NULL,
	"error_code" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spotify_playlist_export_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playlist_target_id" uuid NOT NULL,
	"mode" text DEFAULT 'live' NOT NULL,
	"status" "spotify_playlist_export_run_status" DEFAULT 'planned' NOT NULL,
	"target_playlist_id" text NOT NULL,
	"playlist_name" text NOT NULL,
	"snapshot_before" text,
	"snapshot_after" text,
	"eligible_count" integer DEFAULT 0 NOT NULL,
	"addition_count" integer DEFAULT 0 NOT NULL,
	"already_present_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"ordering_conflict_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spotify_playlist_export_operations" ADD CONSTRAINT "spotify_playlist_export_operations_run_id_spotify_playlist_export_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."spotify_playlist_export_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spotify_playlist_export_operations" ADD CONSTRAINT "spotify_playlist_export_operations_feed_item_id_feed_items_id_fk" FOREIGN KEY ("feed_item_id") REFERENCES "public"."feed_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spotify_playlist_export_operations" ADD CONSTRAINT "spotify_playlist_export_operations_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spotify_playlist_export_runs" ADD CONSTRAINT "spotify_playlist_export_runs_playlist_target_id_playlist_targets_id_fk" FOREIGN KEY ("playlist_target_id") REFERENCES "public"."playlist_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "spotify_playlist_export_operation_feed_unique" ON "spotify_playlist_export_operations" USING btree ("run_id","feed_item_id");--> statement-breakpoint
CREATE INDEX "spotify_playlist_export_operation_status_idx" ON "spotify_playlist_export_operations" USING btree ("run_id","status","desired_ordinal");--> statement-breakpoint
CREATE INDEX "spotify_playlist_export_runs_target_status_idx" ON "spotify_playlist_export_runs" USING btree ("playlist_target_id","status","updated_at");