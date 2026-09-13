ALTER TYPE "public"."artist_provider_identity_status" ADD VALUE 'split_profile' BEFORE 'requires_manual_decision';--> statement-breakpoint
ALTER TYPE "public"."artist_provider_identity_status" ADD VALUE 'intentionally_deferred' BEFORE 'requires_manual_decision';--> statement-breakpoint
ALTER TABLE "artist_provider_identity_statuses" ADD COLUMN "external_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "artist_provider_identity_statuses" ADD COLUMN "user_note" text;--> statement-breakpoint
UPDATE "artist_provider_identity_statuses"
SET "external_ids" = ARRAY["external_id"]
WHERE "external_id" IS NOT NULL;
