ALTER TYPE "public"."spotify_scheduler_work_source" ADD VALUE 'apple_priority';--> statement-breakpoint
CREATE TABLE "discovery_schedule_state" (
	"id" text PRIMARY KEY NOT NULL,
	"phase" text DEFAULT 'idle' NOT NULL,
	"timezone" text DEFAULT 'America/Los_Angeles' NOT NULL,
	"active_campaign_id" uuid,
	"last_apple_campaign_id" uuid,
	"last_apple_scan_completed_at" timestamp with time zone,
	"next_apple_scan_at" timestamp with time zone,
	"playlist_inbox_status" text DEFAULT 'pending' NOT NULL,
	"playlist_inbox_export_run_id" uuid,
	"apple_priority_queued_count" integer DEFAULT 0 NOT NULL,
	"broad_spotify_queued_count" integer DEFAULT 0 NOT NULL,
	"transitioned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discovery_schedule_state_phase_check" CHECK ("discovery_schedule_state"."phase" in ('idle', 'cooldown_wait', 'playlist_inbox', 'apple_priority', 'broad_spotify', 'weekly_apple')),
	CONSTRAINT "discovery_schedule_state_playlist_status_check" CHECK ("discovery_schedule_state"."playlist_inbox_status" in ('pending', 'ready', 'exporting', 'partial', 'completed', 'failed')),
	CONSTRAINT "discovery_schedule_state_counts_check" CHECK ("discovery_schedule_state"."apple_priority_queued_count" >= 0 and "discovery_schedule_state"."broad_spotify_queued_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "discovery_reconciliation_campaigns" DROP CONSTRAINT "discovery_reconciliation_campaign_status_check";--> statement-breakpoint
ALTER TABLE "discovery_reconciliation_campaigns" ADD COLUMN "bootstrap_weekly_apple_scan" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_reconciliation_campaigns" ADD COLUMN "deferred_spotify_artist_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_reconciliation_campaigns" ADD COLUMN "next_apple_scan_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "discovery_reconciliation_campaigns" ADD COLUMN "spotify_deferred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "spotify_playlist_export_runs" ADD COLUMN "discovery_reconciliation_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "spotify_playlist_export_runs" ADD COLUMN "ordering_policy" text DEFAULT 'canonical' NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_schedule_state" ADD CONSTRAINT "discovery_schedule_state_active_campaign_id_discovery_reconciliation_campaigns_id_fk" FOREIGN KEY ("active_campaign_id") REFERENCES "public"."discovery_reconciliation_campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_schedule_state" ADD CONSTRAINT "discovery_schedule_state_last_apple_campaign_id_discovery_reconciliation_campaigns_id_fk" FOREIGN KEY ("last_apple_campaign_id") REFERENCES "public"."discovery_reconciliation_campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spotify_playlist_export_runs" ADD CONSTRAINT "spotify_playlist_export_runs_discovery_reconciliation_campaign_id_discovery_reconciliation_campaigns_id_fk" FOREIGN KEY ("discovery_reconciliation_campaign_id") REFERENCES "public"."discovery_reconciliation_campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_reconciliation_campaigns" ADD CONSTRAINT "discovery_reconciliation_campaign_status_check" CHECK ("discovery_reconciliation_campaigns"."status" in ('planned', 'running', 'paused', 'completed', 'completed_with_spotify_deferred', 'failed', 'cancelled'));