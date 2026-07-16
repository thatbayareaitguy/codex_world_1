CREATE TYPE "public"."availability_state" AS ENUM('playable', 'preview', 'blocked', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."export_status" AS ENUM('pending', 'exported', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."feed_state" AS ENUM('new', 'upcoming', 'saved', 'dismissed', 'listened', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('new', 'matched', 'needs_review', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."provider" AS ENUM('mock', 'spotify', 'musicbrainz', 'youtube', 'soundcloud', 'apple_music', 'tidal');--> statement-breakpoint
CREATE TYPE "public"."release_type" AS ENUM('single', 'ep', 'album', 'remix', 'live', 'feature', 'upload', 'other');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('running', 'completed', 'partial', 'failed');--> statement-breakpoint
CREATE TABLE "artist_external_ids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artist_id" uuid NOT NULL,
	"provider" "provider" NOT NULL,
	"external_id" text NOT NULL,
	"provider_url" text,
	"confirmed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artist_follows" (
	"user_id" uuid NOT NULL,
	"artist_id" uuid NOT NULL,
	"followed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "artist_follows_user_id_artist_id_pk" PRIMARY KEY("user_id","artist_id")
);
--> statement-breakpoint
CREATE TABLE "artists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"sort_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feed_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"candidate_id" uuid,
	"release_id" uuid,
	"track_id" uuid,
	"state" "feed_state" NOT NULL,
	"dedupe_key" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"listened_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"saved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "manual_match_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"selected_track_id" uuid,
	"reason" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "provider" NOT NULL,
	"provider_account_id" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"encrypted_refresh_token" text,
	"token_nonce" text,
	"key_version" integer,
	"access_token_expires_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playlist_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playlist_target_id" uuid NOT NULL,
	"track_id" uuid NOT NULL,
	"provider_track_id" text NOT NULL,
	"status" "export_status" DEFAULT 'pending' NOT NULL,
	"exported_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playlist_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "provider" NOT NULL,
	"provider_playlist_id" text,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "provider" NOT NULL,
	"cursor_scope" text NOT NULL,
	"scope_id" text NOT NULL,
	"cursor_value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_run_id" uuid,
	"provider" "provider" NOT NULL,
	"provider_release_id" text NOT NULL,
	"provider_track_id" text NOT NULL,
	"artist_external_id" text NOT NULL,
	"title" text NOT NULL,
	"normalized_title" text NOT NULL,
	"release_date" date NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"match_status" "match_status" NOT NULL,
	"matched_track_id" uuid,
	"match_rule" text NOT NULL,
	"match_confidence" numeric(4, 3) NOT NULL,
	"match_reasons" text[] NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"normalized_title" text NOT NULL,
	"release_type" "release_type" NOT NULL,
	"release_date" date NOT NULL,
	"release_date_precision" text NOT NULL,
	"upc" text,
	"ean" text,
	"version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "provider",
	"status" "scan_status" DEFAULT 'running' NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"artist_filter" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"discovered_count" integer DEFAULT 0 NOT NULL,
	"inserted_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"provider" "provider" NOT NULL,
	"evidence_type" text NOT NULL,
	"external_id" text NOT NULL,
	"source_url" text NOT NULL,
	"payload_hash" text NOT NULL,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "track_availabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"provider" "provider" NOT NULL,
	"provider_track_id" text NOT NULL,
	"region" text NOT NULL,
	"state" "availability_state" NOT NULL,
	"provider_url" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "track_credits" (
	"track_id" uuid NOT NULL,
	"artist_id" uuid NOT NULL,
	"credit_order" integer NOT NULL,
	"role" text NOT NULL,
	"credited_name" text NOT NULL,
	CONSTRAINT "track_credits_track_id_artist_id_role_pk" PRIMARY KEY("track_id","artist_id","role")
);
--> statement-breakpoint
CREATE TABLE "tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid,
	"title" text NOT NULL,
	"normalized_title" text NOT NULL,
	"duration_ms" integer,
	"isrc" text,
	"disc_number" integer,
	"track_number" integer,
	"musicbrainz_recording_id" text,
	"musicbrainz_release_group_id" text,
	"version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upcoming_announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artist_id" uuid NOT NULL,
	"release_id" uuid,
	"provider" "provider" NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"scheduled_for" date,
	"evidence_url" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artist_external_ids" ADD CONSTRAINT "artist_external_ids_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artist_follows" ADD CONSTRAINT "artist_follows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artist_follows" ADD CONSTRAINT "artist_follows_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_candidate_id_release_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."release_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_match_decisions" ADD CONSTRAINT "manual_match_decisions_candidate_id_release_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."release_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_match_decisions" ADD CONSTRAINT "manual_match_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_match_decisions" ADD CONSTRAINT "manual_match_decisions_selected_track_id_tracks_id_fk" FOREIGN KEY ("selected_track_id") REFERENCES "public"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_exports" ADD CONSTRAINT "playlist_exports_playlist_target_id_playlist_targets_id_fk" FOREIGN KEY ("playlist_target_id") REFERENCES "public"."playlist_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_exports" ADD CONSTRAINT "playlist_exports_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_targets" ADD CONSTRAINT "playlist_targets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_candidates" ADD CONSTRAINT "release_candidates_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_candidates" ADD CONSTRAINT "release_candidates_matched_track_id_tracks_id_fk" FOREIGN KEY ("matched_track_id") REFERENCES "public"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_evidence" ADD CONSTRAINT "source_evidence_candidate_id_release_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."release_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_availabilities" ADD CONSTRAINT "track_availabilities_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_credits" ADD CONSTRAINT "track_credits_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_credits" ADD CONSTRAINT "track_credits_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upcoming_announcements" ADD CONSTRAINT "upcoming_announcements_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upcoming_announcements" ADD CONSTRAINT "upcoming_announcements_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artist_external_provider_id_unique" ON "artist_external_ids" USING btree ("provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artist_external_artist_provider_unique" ON "artist_external_ids" USING btree ("artist_id","provider");--> statement-breakpoint
CREATE INDEX "artists_normalized_name_idx" ON "artists" USING btree ("normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_user_dedupe_unique" ON "feed_items" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "feed_user_state_seen_idx" ON "feed_items" USING btree ("user_id","state","first_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "manual_match_candidate_unique" ON "manual_match_decisions" USING btree ("candidate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_accounts_provider_identity_unique" ON "oauth_accounts" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "playlist_export_target_provider_track_unique" ON "playlist_exports" USING btree ("playlist_target_id","provider_track_id");--> statement-breakpoint
CREATE UNIQUE INDEX "playlist_target_user_provider_unique" ON "playlist_targets" USING btree ("user_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_cursor_scope_unique" ON "provider_cursors" USING btree ("provider","cursor_scope","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "release_candidates_provider_release_track_unique" ON "release_candidates" USING btree ("provider","provider_release_id","provider_track_id");--> statement-breakpoint
CREATE INDEX "releases_title_date_idx" ON "releases" USING btree ("normalized_title","release_date");--> statement-breakpoint
CREATE UNIQUE INDEX "releases_upc_unique" ON "releases" USING btree ("upc") WHERE "releases"."upc" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "releases_ean_unique" ON "releases" USING btree ("ean") WHERE "releases"."ean" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "source_evidence_identity_unique" ON "source_evidence" USING btree ("provider","evidence_type","external_id","payload_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "track_availability_provider_track_region_unique" ON "track_availabilities" USING btree ("provider","provider_track_id","region");--> statement-breakpoint
CREATE UNIQUE INDEX "track_credits_order_unique" ON "track_credits" USING btree ("track_id","credit_order");--> statement-breakpoint
CREATE UNIQUE INDEX "tracks_isrc_unique" ON "tracks" USING btree ("isrc") WHERE "tracks"."isrc" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tracks_musicbrainz_recording_unique" ON "tracks" USING btree ("musicbrainz_recording_id") WHERE "tracks"."musicbrainz_recording_id" is not null;--> statement-breakpoint
CREATE INDEX "tracks_normalized_title_idx" ON "tracks" USING btree ("normalized_title");--> statement-breakpoint
CREATE UNIQUE INDEX "upcoming_provider_external_unique" ON "upcoming_announcements" USING btree ("provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");