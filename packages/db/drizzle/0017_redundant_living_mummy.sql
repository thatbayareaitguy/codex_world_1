CREATE TABLE "itunes_pilot_artist_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"canonical_artist_id" uuid NOT NULL,
	"status" text NOT NULL,
	"selected_artist_id" text,
	"selected_artist_name" text,
	"confidence" numeric(4, 3) NOT NULL,
	"decision_reason" text NOT NULL,
	"ambiguity_reason" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "itunes_pilot_artist_mapping_status_check" CHECK ("itunes_pilot_artist_mappings"."status" in ('exact_confirmed', 'evidence_confirmed', 'ambiguous', 'no_match', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "itunes_pilot_batch_experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"batch_size" integer NOT NULL,
	"artist_ids" jsonb NOT NULL,
	"safe" boolean NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"individual_result_count" integer NOT NULL,
	"batch_result_count" integer NOT NULL,
	"response_bytes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "itunes_pilot_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"canonical_artist_id" uuid NOT NULL,
	"collection_id" text NOT NULL,
	"collection_name" text NOT NULL,
	"normalized_title" text NOT NULL,
	"artist_id" text,
	"artist_name" text,
	"collection_artist_id" text,
	"collection_artist_name" text,
	"release_date" timestamp with time zone NOT NULL,
	"track_count" integer,
	"explicitness" text,
	"primary_genre_name" text,
	"source" text NOT NULL,
	"release_type" text NOT NULL,
	"version" text,
	"view_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "itunes_pilot_ground_truth_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"canonical_artist_id" uuid NOT NULL,
	"canonical_release_id" uuid NOT NULL,
	"spotify_release_id" text NOT NULL,
	"title" text NOT NULL,
	"normalized_title" text NOT NULL,
	"release_date" date NOT NULL,
	"release_date_precision" text NOT NULL,
	"release_type" text NOT NULL,
	"version" text,
	"track_count" integer,
	"credited_artists" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tracks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"completeness_state" text,
	"feed_eligible" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "itunes_pilot_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"canonical_artist_id" uuid NOT NULL,
	"identity_key" text NOT NULL,
	"spotify_release_id" text,
	"apple_collection_id" text,
	"classification" text NOT NULL,
	"date_difference_days" integer,
	"track_count_agreement" boolean,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "itunes_pilot_provider_state" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"next_request_at" timestamp with time zone,
	"last_request_started_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"request_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "itunes_pilot_request_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"endpoint_category" text NOT NULL,
	"request_identity" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"status" integer,
	"response_bytes" integer DEFAULT 0 NOT NULL,
	"retry_after_seconds" integer,
	"error_classification" text,
	"cache_hit" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "itunes_pilot_response_cache" (
	"request_identity" text PRIMARY KEY NOT NULL,
	"response" jsonb NOT NULL,
	"response_hash" text NOT NULL,
	"stored_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "itunes_pilot_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"request_budget" integer DEFAULT 200 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"min_request_interval_ms" integer DEFAULT 3200 NOT NULL,
	"maximum_runtime_ms" integer DEFAULT 1800000 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"stop_reason" text,
	"implementation_commit" text NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "itunes_pilot_run_status_check" CHECK ("itunes_pilot_runs"."status" in ('planned', 'running', 'completed', 'controlled_partial', 'failed')),
	CONSTRAINT "itunes_pilot_run_budget_check" CHECK ("itunes_pilot_runs"."request_budget" between 1 and 200 and "itunes_pilot_runs"."request_count" between 0 and "itunes_pilot_runs"."request_budget"),
	CONSTRAINT "itunes_pilot_run_interval_check" CHECK ("itunes_pilot_runs"."min_request_interval_ms" >= 3200)
);
--> statement-breakpoint
CREATE TABLE "itunes_pilot_snapshot_artists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"canonical_artist_id" uuid NOT NULL,
	"canonical_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"spotify_artist_id" text NOT NULL,
	"spotify_coverage_timestamp" timestamp with time zone NOT NULL,
	"cohort_reason" text NOT NULL,
	"genres" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inclusion_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "itunes_pilot_snapshot_artist_reason_check" CHECK ("itunes_pilot_snapshot_artists"."cohort_reason" in ('positive', 'negative', 'identity_stress'))
);
--> statement-breakpoint
CREATE TABLE "itunes_pilot_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_hash" text NOT NULL,
	"snapshot_timestamp" timestamp with time zone NOT NULL,
	"window_start" date NOT NULL,
	"window_end" date NOT NULL,
	"main_repository_commit" text NOT NULL,
	"main_schema_version" integer NOT NULL,
	"artist_count" integer NOT NULL,
	"release_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "itunes_pilot_snapshots_snapshot_hash_unique" UNIQUE("snapshot_hash")
);
--> statement-breakpoint
CREATE TABLE "itunes_pilot_tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"canonical_artist_id" uuid NOT NULL,
	"track_id" text NOT NULL,
	"collection_id" text,
	"artist_id" text,
	"artist_name" text NOT NULL,
	"collection_artist_id" text,
	"collection_artist_name" text,
	"track_name" text NOT NULL,
	"normalized_title" text NOT NULL,
	"collection_name" text,
	"release_date" timestamp with time zone NOT NULL,
	"duration_ms" integer,
	"disc_number" integer,
	"track_number" integer,
	"track_count" integer,
	"disc_count" integer,
	"explicitness" text,
	"appearance" boolean DEFAULT false NOT NULL,
	"view_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "itunes_pilot_artist_mappings" ADD CONSTRAINT "itunes_pilot_artist_mappings_run_id_itunes_pilot_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."itunes_pilot_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itunes_pilot_batch_experiments" ADD CONSTRAINT "itunes_pilot_batch_experiments_run_id_itunes_pilot_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."itunes_pilot_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itunes_pilot_collections" ADD CONSTRAINT "itunes_pilot_collections_run_id_itunes_pilot_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."itunes_pilot_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itunes_pilot_ground_truth_releases" ADD CONSTRAINT "itunes_pilot_ground_truth_releases_snapshot_id_itunes_pilot_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."itunes_pilot_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itunes_pilot_matches" ADD CONSTRAINT "itunes_pilot_matches_run_id_itunes_pilot_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."itunes_pilot_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itunes_pilot_request_events" ADD CONSTRAINT "itunes_pilot_request_events_run_id_itunes_pilot_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."itunes_pilot_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itunes_pilot_runs" ADD CONSTRAINT "itunes_pilot_runs_snapshot_id_itunes_pilot_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."itunes_pilot_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itunes_pilot_snapshot_artists" ADD CONSTRAINT "itunes_pilot_snapshot_artists_snapshot_id_itunes_pilot_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."itunes_pilot_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itunes_pilot_tracks" ADD CONSTRAINT "itunes_pilot_tracks_run_id_itunes_pilot_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."itunes_pilot_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "itunes_pilot_artist_mapping_unique" ON "itunes_pilot_artist_mappings" USING btree ("run_id","canonical_artist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "itunes_pilot_batch_unique" ON "itunes_pilot_batch_experiments" USING btree ("run_id","entity","batch_size");--> statement-breakpoint
CREATE UNIQUE INDEX "itunes_pilot_collection_unique" ON "itunes_pilot_collections" USING btree ("run_id","canonical_artist_id","collection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "itunes_pilot_ground_truth_release_unique" ON "itunes_pilot_ground_truth_releases" USING btree ("snapshot_id","canonical_artist_id","spotify_release_id");--> statement-breakpoint
CREATE INDEX "itunes_pilot_ground_truth_artist_idx" ON "itunes_pilot_ground_truth_releases" USING btree ("snapshot_id","canonical_artist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "itunes_pilot_match_unique" ON "itunes_pilot_matches" USING btree ("run_id","identity_key");--> statement-breakpoint
CREATE INDEX "itunes_pilot_request_run_started_idx" ON "itunes_pilot_request_events" USING btree ("run_id","started_at");--> statement-breakpoint
CREATE INDEX "itunes_pilot_request_identity_idx" ON "itunes_pilot_request_events" USING btree ("request_identity");--> statement-breakpoint
CREATE UNIQUE INDEX "itunes_pilot_snapshot_artist_unique" ON "itunes_pilot_snapshot_artists" USING btree ("snapshot_id","canonical_artist_id");--> statement-breakpoint
CREATE UNIQUE INDEX "itunes_pilot_track_unique" ON "itunes_pilot_tracks" USING btree ("run_id","canonical_artist_id","track_id");