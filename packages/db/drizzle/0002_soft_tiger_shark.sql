CREATE TYPE "public"."import_status" AS ENUM('preview', 'confirmed', 'completed', 'partial', 'failed');--> statement-breakpoint
CREATE TABLE "artist_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artist_id" uuid NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artist_import_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_run_id" uuid NOT NULL,
	"provider_artist_id" text NOT NULL,
	"provider_url" text NOT NULL,
	"provider_name" text NOT NULL,
	"existing_artist_id" uuid,
	"proposed_action" text NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	"decision" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artist_import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "provider" NOT NULL,
	"status" "import_status" DEFAULT 'preview' NOT NULL,
	"retrieved_count" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"merged_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "provider" NOT NULL,
	"state_hash" text NOT NULL,
	"encrypted_code_verifier" text NOT NULL,
	"verifier_nonce" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "provider" NOT NULL,
	"cache_key" text NOT NULL,
	"value" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_external_ids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid NOT NULL,
	"provider" "provider" NOT NULL,
	"external_id" text NOT NULL,
	"provider_url" text NOT NULL,
	"provider_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_locks" (
	"provider" "provider" PRIMARY KEY NOT NULL,
	"owner_token" text NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "track_external_ids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"provider" "provider" NOT NULL,
	"external_id" text NOT NULL,
	"provider_url" text NOT NULL,
	"provider_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upcoming_date_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"announcement_id" uuid NOT NULL,
	"scheduled_for" date,
	"date_precision" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artist_external_ids" ADD COLUMN "match_score" numeric(4, 3);--> statement-breakpoint
ALTER TABLE "artist_external_ids" ADD COLUMN "match_reasons" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "artist_external_ids" ADD COLUMN "mapping_source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "artist_external_ids" ADD COLUMN "imported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "artist_external_ids" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "artist_follows" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "artist_follows" ADD COLUMN "inclusion_rules" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD COLUMN "provider_user_id" text;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD COLUMN "encrypted_access_token" text;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD COLUMN "access_token_nonce" text;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD COLUMN "last_token_refresh_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD COLUMN "reconnect_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "playlist_exports" ADD COLUMN "app_owned" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "playlist_targets" ADD COLUMN "auto_add_exact_matches" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "playlist_targets" ADD COLUMN "snapshot_id" text;--> statement-breakpoint
ALTER TABLE "playlist_targets" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "release_candidates" ADD COLUMN "matching_algorithm_version" text DEFAULT 'v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "updated_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "playlist_addition_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "provider_results" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "upcoming_announcements" ADD COLUMN "date_precision" text DEFAULT 'day' NOT NULL;--> statement-breakpoint
ALTER TABLE "upcoming_announcements" ADD COLUMN "confidence" numeric(4, 3) DEFAULT '0.700' NOT NULL;--> statement-breakpoint
ALTER TABLE "artist_aliases" ADD CONSTRAINT "artist_aliases_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artist_import_candidates" ADD CONSTRAINT "artist_import_candidates_import_run_id_artist_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."artist_import_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artist_import_candidates" ADD CONSTRAINT "artist_import_candidates_existing_artist_id_artists_id_fk" FOREIGN KEY ("existing_artist_id") REFERENCES "public"."artists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artist_import_runs" ADD CONSTRAINT "artist_import_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_external_ids" ADD CONSTRAINT "release_external_ids_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_external_ids" ADD CONSTRAINT "track_external_ids_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upcoming_date_history" ADD CONSTRAINT "upcoming_date_history_announcement_id_upcoming_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."upcoming_announcements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artist_aliases_artist_name_unique" ON "artist_aliases" USING btree ("artist_id","normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "artist_import_candidate_provider_unique" ON "artist_import_candidates" USING btree ("import_run_id","provider_artist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_states_state_hash_unique" ON "oauth_states" USING btree ("state_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_cache_key_unique" ON "provider_cache" USING btree ("provider","cache_key");--> statement-breakpoint
CREATE UNIQUE INDEX "release_external_provider_id_unique" ON "release_external_ids" USING btree ("provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "release_external_release_provider_unique" ON "release_external_ids" USING btree ("release_id","provider");--> statement-breakpoint
CREATE INDEX "scan_locks_expiry_idx" ON "scan_locks" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "track_external_provider_id_unique" ON "track_external_ids" USING btree ("provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "track_external_track_provider_unique" ON "track_external_ids" USING btree ("track_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "upcoming_date_history_observation_unique" ON "upcoming_date_history" USING btree ("announcement_id","scheduled_for","date_precision");