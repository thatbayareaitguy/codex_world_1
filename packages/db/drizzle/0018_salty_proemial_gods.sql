CREATE TABLE "apple_music_albums" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"canonical_artist_id" uuid NOT NULL,
	"apple_album_id" text NOT NULL,
	"title" text NOT NULL,
	"normalized_title" text NOT NULL,
	"artist_name" text NOT NULL,
	"artist_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"release_date" text,
	"upc" text,
	"track_count" integer,
	"content_rating" text,
	"is_compilation" boolean,
	"is_single" boolean,
	"evidence_url" text,
	"source_view" text NOT NULL,
	"page_number" integer NOT NULL,
	"pagination_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apple_music_artist_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"canonical_artist_id" uuid NOT NULL,
	"inherited_itunes_artist_id" text,
	"status" text NOT NULL,
	"selected_apple_artist_id" text,
	"selected_artist_name" text,
	"confidence" numeric(4, 3) NOT NULL,
	"decision_reason" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apple_music_artist_mapping_status_check" CHECK ("apple_music_artist_mappings"."status" in ('existing_id_confirmed', 'search_confirmed', 'evidence_confirmed', 'ambiguous', 'no_match', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "apple_music_comparison_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"request_budget" integer DEFAULT 200 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"min_request_interval_ms" integer DEFAULT 1100 NOT NULL,
	"maximum_runtime_ms" integer DEFAULT 1800000 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"stop_reason" text,
	"implementation_commit" text NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apple_music_comparison_run_status_check" CHECK ("apple_music_comparison_runs"."status" in ('planned', 'running', 'completed', 'controlled_partial', 'failed')),
	CONSTRAINT "apple_music_comparison_run_budget_check" CHECK ("apple_music_comparison_runs"."request_budget" between 1 and 500 and "apple_music_comparison_runs"."request_count" between 0 and "apple_music_comparison_runs"."request_budget"),
	CONSTRAINT "apple_music_comparison_run_interval_check" CHECK ("apple_music_comparison_runs"."min_request_interval_ms" >= 1100),
	CONSTRAINT "apple_music_comparison_run_runtime_check" CHECK ("apple_music_comparison_runs"."maximum_runtime_ms" between 1000 and 3600000)
);
--> statement-breakpoint
CREATE TABLE "apple_music_comparisons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"canonical_artist_id" uuid NOT NULL,
	"identity_key" text NOT NULL,
	"spotify_release_id" text,
	"apple_album_id" text,
	"classification" text NOT NULL,
	"date_difference_days" integer,
	"track_count_agreement" boolean,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apple_music_mapping_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mapping_id" uuid NOT NULL,
	"apple_artist_id" text NOT NULL,
	"artist_name" text NOT NULL,
	"evidence_url" text,
	"score" integer DEFAULT 0 NOT NULL,
	"decision" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
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
CREATE TABLE "apple_music_songs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"canonical_artist_id" uuid NOT NULL,
	"apple_song_id" text NOT NULL,
	"apple_album_id" text,
	"title" text NOT NULL,
	"normalized_title" text NOT NULL,
	"artist_name" text NOT NULL,
	"artist_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"isrc" text,
	"duration_ms" integer,
	"disc_number" integer,
	"track_number" integer,
	"release_date" text,
	"content_rating" text,
	"evidence_url" text,
	"page_number" integer NOT NULL,
	"pagination_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apple_music_albums" ADD CONSTRAINT "apple_music_albums_run_id_apple_music_comparison_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."apple_music_comparison_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_music_artist_mappings" ADD CONSTRAINT "apple_music_artist_mappings_run_id_apple_music_comparison_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."apple_music_comparison_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_music_comparison_runs" ADD CONSTRAINT "apple_music_comparison_runs_snapshot_id_itunes_pilot_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."itunes_pilot_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_music_comparisons" ADD CONSTRAINT "apple_music_comparisons_run_id_apple_music_comparison_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."apple_music_comparison_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_music_mapping_candidates" ADD CONSTRAINT "apple_music_mapping_candidates_mapping_id_apple_music_artist_mappings_id_fk" FOREIGN KEY ("mapping_id") REFERENCES "public"."apple_music_artist_mappings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_music_request_events" ADD CONSTRAINT "apple_music_request_events_run_id_apple_music_comparison_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."apple_music_comparison_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_music_songs" ADD CONSTRAINT "apple_music_songs_run_id_apple_music_comparison_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."apple_music_comparison_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "apple_music_album_unique" ON "apple_music_albums" USING btree ("run_id","canonical_artist_id","apple_album_id","source_view");--> statement-breakpoint
CREATE UNIQUE INDEX "apple_music_artist_mapping_unique" ON "apple_music_artist_mappings" USING btree ("run_id","canonical_artist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "apple_music_comparison_unique" ON "apple_music_comparisons" USING btree ("run_id","identity_key");--> statement-breakpoint
CREATE UNIQUE INDEX "apple_music_mapping_candidate_unique" ON "apple_music_mapping_candidates" USING btree ("mapping_id","apple_artist_id");--> statement-breakpoint
CREATE INDEX "apple_music_request_run_started_idx" ON "apple_music_request_events" USING btree ("run_id","started_at");--> statement-breakpoint
CREATE INDEX "apple_music_request_identity_idx" ON "apple_music_request_events" USING btree ("request_identity");--> statement-breakpoint
CREATE UNIQUE INDEX "apple_music_song_unique" ON "apple_music_songs" USING btree ("run_id","canonical_artist_id","apple_song_id");