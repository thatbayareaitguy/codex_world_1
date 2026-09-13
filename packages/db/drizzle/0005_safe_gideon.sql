ALTER TYPE "public"."provider" ADD VALUE 'reddit' BEFORE 'youtube';--> statement-breakpoint
ALTER TYPE "public"."release_type" ADD VALUE 'radio_show';--> statement-breakpoint
ALTER TYPE "public"."release_type" ADD VALUE 'podcast';--> statement-breakpoint
ALTER TYPE "public"."release_type" ADD VALUE 'playlist';--> statement-breakpoint
ALTER TYPE "public"."release_type" ADD VALUE 'unknown';--> statement-breakpoint
CREATE TABLE "application_metadata" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operation_locks" (
	"lock_key" text PRIMARY KEY NOT NULL,
	"owner_token" text NOT NULL,
	"operation_type" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reddit_candidate_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parse_result_id" uuid NOT NULL,
	"canonical_artist_id" uuid,
	"canonical_release_id" uuid,
	"canonical_track_id" uuid,
	"release_candidate_id" uuid,
	"match_confidence" numeric(4, 3) NOT NULL,
	"match_reasons" text[] NOT NULL,
	"review_status" text DEFAULT 'needs_review' NOT NULL,
	"spotify_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"musicbrainz_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reddit_external_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"parse_result_id" uuid,
	"category" text NOT NULL,
	"original_url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"detected_host" text NOT NULL,
	"verification_status" text DEFAULT 'reddit_supplied_unverified' NOT NULL,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reddit_parse_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"parser_version" text NOT NULL,
	"candidate_hash" text NOT NULL,
	"source_line" integer DEFAULT 0 NOT NULL,
	"section_heading" text,
	"candidate_artist_text" text NOT NULL,
	"candidate_title_text" text NOT NULL,
	"candidate_release_type" text NOT NULL,
	"candidate_version" text,
	"candidate_label" text,
	"claimed_release_date" date,
	"date_source_text" text,
	"date_confidence" text,
	"parse_confidence" numeric(4, 3) NOT NULL,
	"parse_reasons" text[] NOT NULL,
	"failure_reasons" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reddit_reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"checked_count" integer DEFAULT 0 NOT NULL,
	"deleted_count" integer DEFAULT 0 NOT NULL,
	"preserved_canonical_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"error_summary" text
);
--> statement-breakpoint
CREATE TABLE "reddit_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"subreddit" text NOT NULL,
	"display_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"initial_backfill_days" integer DEFAULT 14 NOT NULL,
	"scan_overlap_hours" integer DEFAULT 72 NOT NULL,
	"max_pages_per_scan" integer DEFAULT 10 NOT NULL,
	"flair_boosts" text[] DEFAULT '{}'::text[] NOT NULL,
	"flair_exclusions" text[] DEFAULT '{}'::text[] NOT NULL,
	"roundup_title_phrases" text[] DEFAULT '{}'::text[] NOT NULL,
	"notes" text,
	"last_successful_scan_at" timestamp with time zone,
	"last_error" text,
	"last_seen_fullname" text,
	"last_seen_created_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reddit_sources_subreddit_format_check" CHECK ("reddit_sources"."subreddit" ~ '^[A-Za-z0-9_]{3,21}$'),
	CONSTRAINT "reddit_sources_scan_limits_check" CHECK ("reddit_sources"."initial_backfill_days" between 1 and 365 and "reddit_sources"."scan_overlap_hours" between 1 and 720 and "reddit_sources"."max_pages_per_scan" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "reddit_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"fullname" text NOT NULL,
	"reddit_post_id" text NOT NULL,
	"subreddit" text NOT NULL,
	"permalink" text,
	"title" text,
	"self_text" text,
	"flair_text" text,
	"post_type" text NOT NULL,
	"is_self_post" boolean NOT NULL,
	"destination_url" text,
	"crosspost_origin_fullname" text,
	"reddit_created_at" timestamp with time zone NOT NULL,
	"reddit_edited_at" timestamp with time zone,
	"source_state" text DEFAULT 'active' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "trigger_type" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "providers_requested" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "providers_completed" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "providers_failed" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "artists_processed_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "duplicates_ignored_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "detailed_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reddit_candidate_matches" ADD CONSTRAINT "reddit_candidate_matches_parse_result_id_reddit_parse_results_id_fk" FOREIGN KEY ("parse_result_id") REFERENCES "public"."reddit_parse_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reddit_candidate_matches" ADD CONSTRAINT "reddit_candidate_matches_canonical_artist_id_artists_id_fk" FOREIGN KEY ("canonical_artist_id") REFERENCES "public"."artists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reddit_candidate_matches" ADD CONSTRAINT "reddit_candidate_matches_canonical_release_id_releases_id_fk" FOREIGN KEY ("canonical_release_id") REFERENCES "public"."releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reddit_candidate_matches" ADD CONSTRAINT "reddit_candidate_matches_canonical_track_id_tracks_id_fk" FOREIGN KEY ("canonical_track_id") REFERENCES "public"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reddit_candidate_matches" ADD CONSTRAINT "reddit_candidate_matches_release_candidate_id_release_candidates_id_fk" FOREIGN KEY ("release_candidate_id") REFERENCES "public"."release_candidates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reddit_candidate_matches" ADD CONSTRAINT "reddit_candidate_matches_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reddit_external_links" ADD CONSTRAINT "reddit_external_links_submission_id_reddit_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."reddit_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reddit_external_links" ADD CONSTRAINT "reddit_external_links_parse_result_id_reddit_parse_results_id_fk" FOREIGN KEY ("parse_result_id") REFERENCES "public"."reddit_parse_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reddit_external_links" ADD CONSTRAINT "reddit_external_links_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reddit_parse_results" ADD CONSTRAINT "reddit_parse_results_submission_id_reddit_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."reddit_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reddit_sources" ADD CONSTRAINT "reddit_sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reddit_submissions" ADD CONSTRAINT "reddit_submissions_source_id_reddit_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."reddit_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operation_locks_expiry_idx" ON "operation_locks" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reddit_candidate_match_parse_unique" ON "reddit_candidate_matches" USING btree ("parse_result_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reddit_external_link_submission_url_unique" ON "reddit_external_links" USING btree ("submission_id","normalized_url");--> statement-breakpoint
CREATE UNIQUE INDEX "reddit_parse_submission_line_candidate_unique" ON "reddit_parse_results" USING btree ("submission_id","source_line","candidate_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "reddit_sources_user_subreddit_unique" ON "reddit_sources" USING btree ("user_id",lower("subreddit"));--> statement-breakpoint
CREATE UNIQUE INDEX "reddit_submissions_fullname_unique" ON "reddit_submissions" USING btree ("fullname");--> statement-breakpoint
CREATE INDEX "reddit_submissions_reconciliation_idx" ON "reddit_submissions" USING btree ("source_state","last_checked_at");--> statement-breakpoint
CREATE INDEX "reddit_submissions_source_created_idx" ON "reddit_submissions" USING btree ("source_id","reddit_created_at");