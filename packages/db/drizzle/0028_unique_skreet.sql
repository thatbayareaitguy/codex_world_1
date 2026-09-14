ALTER TABLE "spotify_playlist_export_runs" ALTER COLUMN "ordering_policy" SET DEFAULT 'release_date_custom_order';--> statement-breakpoint
ALTER TABLE "playlist_targets" ADD COLUMN "snapshot_items" jsonb;--> statement-breakpoint
ALTER TABLE "playlist_targets" ADD COLUMN "snapshot_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "playlist_targets" ADD COLUMN "order_canary_verified_at" timestamp with time zone;