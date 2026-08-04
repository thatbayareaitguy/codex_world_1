CREATE TABLE "apple_music_durable_artist_mappings" (
	"canonical_artist_id" uuid PRIMARY KEY NOT NULL,
	"apple_artist_id" text NOT NULL,
	"artist_name" text NOT NULL,
	"confirmation_method" text NOT NULL,
	"source_classification" text NOT NULL,
	"artifact_hash" text,
	"confirmed_run_id" uuid NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apple_music_durable_confirmation_method_check" CHECK ("apple_music_durable_artist_mappings"."confirmation_method" in ('legacy_validated', 'manual_confirmation', 'high_confidence_seed', 'evidence_supported_seed', 'catalog_evidence'))
);
--> statement-breakpoint
CREATE TABLE "apple_music_identity_campaign_entries" (
	"campaign_id" uuid NOT NULL,
	"canonical_artist_id" uuid NOT NULL,
	"artifact_classification" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"validation_path" text NOT NULL,
	"batch_index" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"candidate_count" integer DEFAULT 0 NOT NULL,
	"selected_apple_artist_id" text,
	"selected_artist_name" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"manual_review_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apple_music_identity_campaign_entries_campaign_id_canonical_artist_id_pk" PRIMARY KEY("campaign_id","canonical_artist_id"),
	CONSTRAINT "apple_music_identity_campaign_entry_status_check" CHECK ("apple_music_identity_campaign_entries"."status" in ('pending', 'reused', 'confirmed', 'ambiguous', 'rejected', 'missing', 'manual_review')),
	CONSTRAINT "apple_music_identity_campaign_entry_attempts_check" CHECK ("apple_music_identity_campaign_entries"."attempts" >= 0 and "apple_music_identity_campaign_entries"."candidate_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "apple_music_identity_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_hash" text NOT NULL,
	"watchlist_hash" text NOT NULL,
	"schema_version" integer NOT NULL,
	"stage" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"current_run_id" uuid,
	"implementation_commit" text NOT NULL,
	"next_batch_index" integer DEFAULT 0 NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stop_reason" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apple_music_identity_campaign_stage_check" CHECK ("apple_music_identity_campaigns"."stage" in ('strong_seeds', 'ambiguous_automation')),
	CONSTRAINT "apple_music_identity_campaign_status_check" CHECK ("apple_music_identity_campaigns"."status" in ('planned', 'running', 'completed', 'controlled_partial', 'failed')),
	CONSTRAINT "apple_music_identity_campaign_batch_check" CHECK ("apple_music_identity_campaigns"."next_batch_index" >= 0)
);
--> statement-breakpoint
ALTER TABLE "apple_music_durable_artist_mappings" ADD CONSTRAINT "apple_music_durable_artist_mappings_confirmed_run_id_apple_music_comparison_runs_id_fk" FOREIGN KEY ("confirmed_run_id") REFERENCES "public"."apple_music_comparison_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_music_identity_campaign_entries" ADD CONSTRAINT "apple_music_identity_campaign_entries_campaign_id_apple_music_identity_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."apple_music_identity_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apple_music_identity_campaigns" ADD CONSTRAINT "apple_music_identity_campaigns_current_run_id_apple_music_comparison_runs_id_fk" FOREIGN KEY ("current_run_id") REFERENCES "public"."apple_music_comparison_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apple_music_durable_artist_id_idx" ON "apple_music_durable_artist_mappings" USING btree ("apple_artist_id");--> statement-breakpoint
CREATE INDEX "apple_music_identity_campaign_entry_status_idx" ON "apple_music_identity_campaign_entries" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "apple_music_identity_campaign_artifact_stage_unique" ON "apple_music_identity_campaigns" USING btree ("artifact_hash","stage");--> statement-breakpoint
INSERT INTO "apple_music_durable_artist_mappings" (
	"canonical_artist_id",
	"apple_artist_id",
	"artist_name",
	"confirmation_method",
	"source_classification",
	"confirmed_run_id",
	"confirmed_at",
	"created_at",
	"updated_at"
)
SELECT DISTINCT ON ("canonical_artist_id")
	"canonical_artist_id",
	"selected_apple_artist_id",
	"selected_artist_name",
	'legacy_validated',
	"status",
	"run_id",
	"created_at",
	"created_at",
	"updated_at"
FROM "apple_music_artist_mappings"
WHERE "status" IN ('existing_id_confirmed', 'search_confirmed', 'evidence_confirmed')
	AND "selected_apple_artist_id" IS NOT NULL
	AND "selected_artist_name" IS NOT NULL
ORDER BY "canonical_artist_id", "created_at" DESC;
