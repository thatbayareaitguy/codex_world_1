CREATE TABLE "apple_identity_candidate_catalogs" (
	"apple_artist_id" text PRIMARY KEY NOT NULL,
	"catalog" jsonb NOT NULL,
	"error_classification" text,
	"fetched_at" timestamp with time zone NOT NULL,
	"request_identity" text NOT NULL,
	"response_hash" text NOT NULL,
	"resource_status" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apple_identity_candidate_rankings" (
	"artist_id" uuid NOT NULL,
	"apple_artist_id" text NOT NULL,
	"rank" integer NOT NULL,
	"score" numeric(4, 3) NOT NULL,
	"auto_confirm_eligible" boolean DEFAULT false NOT NULL,
	"elimination_safe" boolean DEFAULT false NOT NULL,
	"exact_link_source" text,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"contradictions" text[] DEFAULT '{}'::text[] NOT NULL,
	"signals" jsonb NOT NULL,
	"title_overlaps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"calibration_version" text NOT NULL,
	"ranked_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apple_identity_candidate_rankings_artist_id_apple_artist_id_pk" PRIMARY KEY("artist_id","apple_artist_id")
);
--> statement-breakpoint
ALTER TABLE "apple_identity_candidate_rankings" ADD CONSTRAINT "apple_identity_candidate_rankings_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apple_identity_candidate_catalog_status_idx" ON "apple_identity_candidate_catalogs" USING btree ("resource_status","updated_at");--> statement-breakpoint
CREATE INDEX "apple_identity_candidate_rankings_artist_rank_idx" ON "apple_identity_candidate_rankings" USING btree ("artist_id","rank");