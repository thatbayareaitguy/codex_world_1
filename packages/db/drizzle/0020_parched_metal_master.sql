CREATE TABLE "apple_music_recent_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_artist_id" uuid NOT NULL,
	"identity_key" text NOT NULL,
	"last_run_id" uuid NOT NULL,
	"apple_album_id" text,
	"apple_song_id" text,
	"album_title" text NOT NULL,
	"song_title" text,
	"apple_artist_name" text NOT NULL,
	"named_remixer" text,
	"release_date" text,
	"upc" text,
	"classification" text NOT NULL,
	"evidence_strength" text NOT NULL,
	"source_arms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"candidate_status" text NOT NULL,
	"comparison_status" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apple_music_recent_candidates" ADD CONSTRAINT "apple_music_recent_candidates_last_run_id_apple_music_comparison_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."apple_music_comparison_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "apple_music_recent_candidate_identity_unique" ON "apple_music_recent_candidates" USING btree ("canonical_artist_id","identity_key");--> statement-breakpoint
CREATE INDEX "apple_music_recent_candidate_run_idx" ON "apple_music_recent_candidates" USING btree ("last_run_id");