CREATE TYPE "public"."spotify_sync_campaign_member_status" AS ENUM('pending', 'reserved', 'succeeded', 'blocked', 'skipped', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."spotify_sync_campaign_status" AS ENUM('planned', 'running', 'canary_review', 'base_target_reached', 'draining', 'paused', 'completed', 'cancelled', 'failed');--> statement-breakpoint
CREATE TABLE "spotify_sync_campaign_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"artist_id" uuid NOT NULL,
	"scheduler_work_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"baseline_spotify_artist_id" text NOT NULL,
	"baseline_eligible_at" timestamp with time zone NOT NULL,
	"status" "spotify_sync_campaign_member_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"reservation_token" uuid,
	"reserved_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"qualified_at" timestamp with time zone,
	"blocked_reason" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spotify_sync_campaign_member_ordinal_check" CHECK ("spotify_sync_campaign_members"."ordinal" > 0),
	CONSTRAINT "spotify_sync_campaign_member_reservation_check" CHECK (("spotify_sync_campaign_members"."status" = 'reserved' and "spotify_sync_campaign_members"."reservation_token" is not null and "spotify_sync_campaign_members"."reserved_at" is not null and "spotify_sync_campaign_members"."lease_expires_at" is not null) or ("spotify_sync_campaign_members"."status" <> 'reserved' and "spotify_sync_campaign_members"."reservation_token" is null and "spotify_sync_campaign_members"."reserved_at" is null and "spotify_sync_campaign_members"."lease_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE "spotify_sync_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_key" text NOT NULL,
	"campaign_type" text DEFAULT 'bounded_initial_sync' NOT NULL,
	"status" "spotify_sync_campaign_status" DEFAULT 'planned' NOT NULL,
	"target_successes" integer NOT NULL,
	"canary_target" integer NOT NULL,
	"qualifying_success_count" integer DEFAULT 0 NOT NULL,
	"active_reservation_count" integer DEFAULT 0 NOT NULL,
	"baseline_artist_count" integer NOT NULL,
	"ordering_version" text DEFAULT 'scheduler-priority-v1' NOT NULL,
	"base_interval_ms" integer NOT NULL,
	"next_base_claim_at" timestamp with time zone,
	"canary_passed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"stop_reason" text,
	"last_error" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"effective_configuration" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spotify_sync_campaign_targets_check" CHECK ("spotify_sync_campaigns"."target_successes" > 0 and "spotify_sync_campaigns"."canary_target" > 0 and "spotify_sync_campaigns"."canary_target" <= "spotify_sync_campaigns"."target_successes" and "spotify_sync_campaigns"."baseline_artist_count" >= "spotify_sync_campaigns"."target_successes"),
	CONSTRAINT "spotify_sync_campaign_counts_check" CHECK ("spotify_sync_campaigns"."qualifying_success_count" >= 0 and "spotify_sync_campaigns"."active_reservation_count" >= 0 and "spotify_sync_campaigns"."qualifying_success_count" + "spotify_sync_campaigns"."active_reservation_count" <= "spotify_sync_campaigns"."target_successes"),
	CONSTRAINT "spotify_sync_campaign_interval_check" CHECK ("spotify_sync_campaigns"."base_interval_ms" >= 10000)
);
--> statement-breakpoint
ALTER TABLE "spotify_scheduler_work" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "spotify_scheduler_work" ADD COLUMN "campaign_member_id" uuid;--> statement-breakpoint
ALTER TABLE "spotify_sync_campaign_members" ADD CONSTRAINT "spotify_sync_campaign_members_campaign_id_spotify_sync_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."spotify_sync_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spotify_sync_campaign_members" ADD CONSTRAINT "spotify_sync_campaign_members_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "spotify_sync_campaign_member_artist_unique" ON "spotify_sync_campaign_members" USING btree ("campaign_id","artist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spotify_sync_campaign_member_ordinal_unique" ON "spotify_sync_campaign_members" USING btree ("campaign_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "spotify_sync_campaign_member_work_unique" ON "spotify_sync_campaign_members" USING btree ("campaign_id","scheduler_work_id");--> statement-breakpoint
CREATE INDEX "spotify_sync_campaign_member_status_idx" ON "spotify_sync_campaign_members" USING btree ("campaign_id","status","ordinal");--> statement-breakpoint
CREATE INDEX "spotify_sync_campaign_member_lease_idx" ON "spotify_sync_campaign_members" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "spotify_sync_campaign_key_unique" ON "spotify_sync_campaigns" USING btree ("campaign_key");--> statement-breakpoint
CREATE INDEX "spotify_sync_campaign_status_idx" ON "spotify_sync_campaigns" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "spotify_sync_campaign_lease_idx" ON "spotify_sync_campaigns" USING btree ("lease_expires_at");--> statement-breakpoint
ALTER TABLE "spotify_scheduler_work" ADD CONSTRAINT "spotify_scheduler_work_campaign_id_spotify_sync_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."spotify_sync_campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spotify_scheduler_work_campaign_idx" ON "spotify_scheduler_work" USING btree ("campaign_id","status","work_type","due_at");