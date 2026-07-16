CREATE TABLE "artist_mapping_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artist_id" uuid NOT NULL,
	"provider" "provider" NOT NULL,
	"proposed_external_id" text NOT NULL,
	"provider_name" text NOT NULL,
	"match_score" numeric(4, 3) NOT NULL,
	"match_reasons" text[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "release_external_release_provider_unique";--> statement-breakpoint
DROP INDEX "track_external_track_provider_unique";--> statement-breakpoint
ALTER TABLE "artist_mapping_reviews" ADD CONSTRAINT "artist_mapping_reviews_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artist_mapping_review_proposal_unique" ON "artist_mapping_reviews" USING btree ("artist_id","provider","proposed_external_id");