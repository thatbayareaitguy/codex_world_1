CREATE TYPE "public"."artist_provider_identity_status" AS ENUM('automatically_confirmed', 'manually_confirmed', 'confirmed_unavailable', 'alias_or_duplicate', 'intentionally_excluded', 'requires_manual_decision');--> statement-breakpoint
CREATE TABLE "artist_provider_identity_statuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artist_id" uuid NOT NULL,
	"provider" "provider" NOT NULL,
	"status" "artist_provider_identity_status" NOT NULL,
	"external_id" text,
	"linked_artist_id" uuid,
	"reason" text NOT NULL,
	"evidence" text[] DEFAULT '{}'::text[] NOT NULL,
	"decided_by" text DEFAULT 'system' NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artist_provider_identity_statuses" ADD CONSTRAINT "artist_provider_identity_statuses_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artist_provider_identity_statuses" ADD CONSTRAINT "artist_provider_identity_statuses_linked_artist_id_artists_id_fk" FOREIGN KEY ("linked_artist_id") REFERENCES "public"."artists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artist_provider_identity_artist_provider_unique" ON "artist_provider_identity_statuses" USING btree ("artist_id","provider");--> statement-breakpoint
CREATE INDEX "artist_provider_identity_status_idx" ON "artist_provider_identity_statuses" USING btree ("provider","status","updated_at","artist_id");--> statement-breakpoint
INSERT INTO "artist_provider_identity_statuses" (
	"artist_id",
	"provider",
	"status",
	"external_id",
	"reason",
	"evidence",
	"decided_by",
	"decided_at"
)
SELECT DISTINCT
	"follow"."artist_id",
	"provider_list"."provider",
	CASE
		WHEN "external"."confirmed" = true AND "external"."mapping_source" LIKE 'user_confirmed_%'
			THEN 'manually_confirmed'::"artist_provider_identity_status"
		WHEN "external"."confirmed" = true
			THEN 'automatically_confirmed'::"artist_provider_identity_status"
		ELSE 'requires_manual_decision'::"artist_provider_identity_status"
	END,
	CASE WHEN "external"."confirmed" = true THEN "external"."external_id" ELSE NULL END,
	CASE
		WHEN "external"."confirmed" = true AND "external"."mapping_source" LIKE 'user_confirmed_%'
			THEN 'User manually confirmed the provider identity.'
		WHEN "external"."confirmed" = true
			THEN 'Existing confirmed provider identity met the automatic confidence threshold.'
		ELSE 'No provider identity met the automatic confidence threshold; manual review is required.'
	END,
	COALESCE("external"."match_reasons", '{}'::text[]),
	CASE
		WHEN "external"."confirmed" = true AND "external"."mapping_source" LIKE 'user_confirmed_%'
			THEN 'user'
		ELSE 'system'
	END,
	CASE WHEN "external"."confirmed" = true THEN "external"."confirmed_at" ELSE NULL END
FROM "artist_follows" "follow"
CROSS JOIN (
	VALUES ('spotify'::"provider"), ('apple_music'::"provider")
) AS "provider_list"("provider")
LEFT JOIN "artist_external_ids" "external"
	ON "external"."artist_id" = "follow"."artist_id"
	AND "external"."provider" = "provider_list"."provider"
	AND "external"."confirmed" = true
WHERE "follow"."active" = true
ON CONFLICT ("artist_id", "provider") DO NOTHING;
