CREATE TABLE "discovery_reconciliation_artists" (
	"campaign_id" uuid NOT NULL,
	"artist_id" uuid NOT NULL,
	"apple_artist_id" text NOT NULL,
	"spotify_artist_id" text NOT NULL,
	"position" integer NOT NULL,
	"priority_reason" text DEFAULT 'rotating_fallback' NOT NULL,
	"apple_status" text DEFAULT 'pending' NOT NULL,
	"apple_retry_eligible_at" timestamp with time zone,
	"apple_batch_id" uuid,
	"apple_request_count" integer DEFAULT 0 NOT NULL,
	"apple_release_count" integer DEFAULT 0 NOT NULL,
	"apple_candidate_count" integer DEFAULT 0 NOT NULL,
	"apple_recent_discovery" boolean DEFAULT false NOT NULL,
	"latest_apple_release_date" date,
	"spotify_status" text DEFAULT 'pending' NOT NULL,
	"spotify_retry_eligible_at" timestamp with time zone,
	"spotify_batch_id" uuid,
	"spotify_request_count" integer DEFAULT 0 NOT NULL,
	"spotify_release_count" integer DEFAULT 0 NOT NULL,
	"spotify_candidate_count" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_classification" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discovery_reconciliation_artists_campaign_id_artist_id_pk" PRIMARY KEY("campaign_id","artist_id"),
	CONSTRAINT "discovery_reconciliation_artist_apple_status_check" CHECK ("discovery_reconciliation_artists"."apple_status" in ('pending', 'completed', 'retryable', 'terminal', 'failed')),
	CONSTRAINT "discovery_reconciliation_artist_spotify_status_check" CHECK ("discovery_reconciliation_artists"."spotify_status" in ('pending', 'selected', 'completed', 'partial', 'rate_limited', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "discovery_reconciliation_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_key" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"stage" text DEFAULT 'apple_discovery' NOT NULL,
	"window_start" date NOT NULL,
	"window_end" date NOT NULL,
	"total_artists" integer NOT NULL,
	"spotify_cohort_size" integer NOT NULL,
	"spotify_rotation_size" integer NOT NULL,
	"spotify_page_limit" integer NOT NULL,
	"apple_artists_scanned" integer DEFAULT 0 NOT NULL,
	"spotify_artists_scanned" integer DEFAULT 0 NOT NULL,
	"matched_release_count" integer DEFAULT 0 NOT NULL,
	"apple_only_release_count" integer DEFAULT 0 NOT NULL,
	"spotify_only_release_count" integer DEFAULT 0 NOT NULL,
	"uncertain_release_count" integer DEFAULT 0 NOT NULL,
	"missing_spotify_track_count" integer DEFAULT 0 NOT NULL,
	"playlist_eligible_track_count" integer DEFAULT 0 NOT NULL,
	"apple_request_count" integer DEFAULT 0 NOT NULL,
	"spotify_request_count" integer DEFAULT 0 NOT NULL,
	"apple_rate_limit_count" integer DEFAULT 0 NOT NULL,
	"spotify_rate_limit_count" integer DEFAULT 0 NOT NULL,
	"apple_retry_count" integer DEFAULT 0 NOT NULL,
	"spotify_retry_count" integer DEFAULT 0 NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"apple_batch_id" uuid,
	"playlist_preview" jsonb,
	"provider_cooldowns" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_configuration" jsonb NOT NULL,
	"error_classification" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discovery_reconciliation_campaign_status_check" CHECK ("discovery_reconciliation_campaigns"."status" in ('planned', 'running', 'paused', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "discovery_reconciliation_campaign_stage_check" CHECK ("discovery_reconciliation_campaigns"."stage" in ('apple_discovery', 'spotify_reconciliation', 'internal_reconciliation', 'playlist_preview', 'completed')),
	CONSTRAINT "discovery_reconciliation_campaign_configuration_check" CHECK ("discovery_reconciliation_campaigns"."total_artists" > 0 and "discovery_reconciliation_campaigns"."spotify_cohort_size" > 0 and "discovery_reconciliation_campaigns"."spotify_rotation_size" >= 0 and "discovery_reconciliation_campaigns"."spotify_rotation_size" <= "discovery_reconciliation_campaigns"."spotify_cohort_size" and "discovery_reconciliation_campaigns"."spotify_page_limit" > 0)
);
--> statement-breakpoint
CREATE TABLE "release_provider_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"artist_id" uuid NOT NULL,
	"reconciliation_key" text NOT NULL,
	"status" text NOT NULL,
	"title" text NOT NULL,
	"release_date" date NOT NULL,
	"release_type" text NOT NULL,
	"apple_provider_release_id" text,
	"spotify_provider_release_id" text,
	"apple_canonical_release_id" uuid,
	"spotify_canonical_release_id" uuid,
	"confidence" numeric(4, 3) NOT NULL,
	"reasons" text[] NOT NULL,
	"apple_track_count" integer DEFAULT 0 NOT NULL,
	"spotify_track_count" integer DEFAULT 0 NOT NULL,
	"matched_track_count" integer DEFAULT 0 NOT NULL,
	"missing_spotify_track_count" integer DEFAULT 0 NOT NULL,
	"playlist_eligible_track_count" integer DEFAULT 0 NOT NULL,
	"playlist_eligible" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_provider_reconciliation_status_check" CHECK ("release_provider_reconciliations"."status" in ('matched', 'apple_only', 'spotify_only', 'uncertain', 'missing_spotify_track')),
	CONSTRAINT "release_provider_reconciliation_provider_check" CHECK ("release_provider_reconciliations"."apple_provider_release_id" is not null or "release_provider_reconciliations"."spotify_provider_release_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "spotify_request_events" ADD COLUMN "discovery_reconciliation_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "discovery_reconciliation_artists" ADD CONSTRAINT "discovery_reconciliation_artists_campaign_id_discovery_reconciliation_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."discovery_reconciliation_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_reconciliation_artists" ADD CONSTRAINT "discovery_reconciliation_artists_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_reconciliation_artists" ADD CONSTRAINT "discovery_reconciliation_artists_apple_batch_id_apple_music_scan_batches_id_fk" FOREIGN KEY ("apple_batch_id") REFERENCES "public"."apple_music_scan_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_reconciliation_artists" ADD CONSTRAINT "discovery_reconciliation_artists_spotify_batch_id_spotify_scan_batches_id_fk" FOREIGN KEY ("spotify_batch_id") REFERENCES "public"."spotify_scan_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_reconciliation_campaigns" ADD CONSTRAINT "discovery_reconciliation_campaigns_apple_batch_id_apple_music_scan_batches_id_fk" FOREIGN KEY ("apple_batch_id") REFERENCES "public"."apple_music_scan_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_provider_reconciliations" ADD CONSTRAINT "release_provider_reconciliations_campaign_id_discovery_reconciliation_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."discovery_reconciliation_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_provider_reconciliations" ADD CONSTRAINT "release_provider_reconciliations_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_provider_reconciliations" ADD CONSTRAINT "release_provider_reconciliations_apple_canonical_release_id_releases_id_fk" FOREIGN KEY ("apple_canonical_release_id") REFERENCES "public"."releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_provider_reconciliations" ADD CONSTRAINT "release_provider_reconciliations_spotify_canonical_release_id_releases_id_fk" FOREIGN KEY ("spotify_canonical_release_id") REFERENCES "public"."releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_reconciliation_artist_position_unique" ON "discovery_reconciliation_artists" USING btree ("campaign_id","position");--> statement-breakpoint
CREATE INDEX "discovery_reconciliation_artist_stage_idx" ON "discovery_reconciliation_artists" USING btree ("campaign_id","spotify_status","position");--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_reconciliation_campaign_key_unique" ON "discovery_reconciliation_campaigns" USING btree ("campaign_key");--> statement-breakpoint
CREATE INDEX "discovery_reconciliation_campaign_status_idx" ON "discovery_reconciliation_campaigns" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "release_provider_reconciliation_identity_unique" ON "release_provider_reconciliations" USING btree ("campaign_id","artist_id","reconciliation_key");--> statement-breakpoint
CREATE INDEX "release_provider_reconciliation_status_idx" ON "release_provider_reconciliations" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "spotify_request_events_discovery_campaign_idx" ON "spotify_request_events" USING btree ("discovery_reconciliation_campaign_id","started_at");