ALTER TABLE "spotify_request_events" ADD COLUMN "provider_reason_token" text;--> statement-breakpoint
ALTER TABLE "spotify_request_events" ADD COLUMN "rate_limit_classification" text;--> statement-breakpoint
CREATE INDEX "spotify_request_events_429_classification_idx" ON "spotify_request_events" USING btree ("status","rate_limit_classification","started_at");