ALTER TABLE "spotify_scheduler_work" DROP CONSTRAINT "spotify_scheduler_work_target_check";--> statement-breakpoint
ALTER TYPE "public"."spotify_scheduler_work_type" RENAME TO "spotify_scheduler_work_type_old";--> statement-breakpoint
CREATE TYPE "public"."spotify_scheduler_work_type" AS ENUM('base_artist', 'release_detail', 'release_tracks', 'artist_reconciliation', 'track_resolution');--> statement-breakpoint
ALTER TABLE "spotify_scheduler_work" ALTER COLUMN "work_type" TYPE "public"."spotify_scheduler_work_type" USING "work_type"::text::"public"."spotify_scheduler_work_type";--> statement-breakpoint
ALTER TABLE "spotify_request_events" ALTER COLUMN "scheduler_work_type" TYPE "public"."spotify_scheduler_work_type" USING "scheduler_work_type"::text::"public"."spotify_scheduler_work_type";--> statement-breakpoint
DROP TYPE "public"."spotify_scheduler_work_type_old";--> statement-breakpoint
CREATE TYPE "public"."spotify_track_resolution_mode" AS ENUM('isrc', 'single', 'album', 'manual');--> statement-breakpoint
ALTER TABLE "spotify_scheduler_work" ADD COLUMN "target_track_id" uuid;--> statement-breakpoint
ALTER TABLE "spotify_scheduler_work" ADD COLUMN "target_isrc" text;--> statement-breakpoint
ALTER TABLE "spotify_scheduler_work" ADD COLUMN "target_spotify_track_id" text;--> statement-breakpoint
ALTER TABLE "spotify_scheduler_work" ADD COLUMN "track_resolution_mode" "spotify_track_resolution_mode";--> statement-breakpoint
ALTER TABLE "spotify_scheduler_work" ADD CONSTRAINT "spotify_scheduler_work_target_track_id_tracks_id_fk" FOREIGN KEY ("target_track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spotify_scheduler_work_target_track_idx" ON "spotify_scheduler_work" USING btree ("target_track_id","status");--> statement-breakpoint
ALTER TABLE "spotify_scheduler_work" ADD CONSTRAINT "spotify_scheduler_work_target_check" CHECK ((
        ("spotify_scheduler_work"."work_type" in ('base_artist', 'artist_reconciliation') and "spotify_scheduler_work"."artist_id" is not null and "spotify_scheduler_work"."expected_spotify_artist_id" is not null)
        or ("spotify_scheduler_work"."work_type" = 'release_detail' and "spotify_scheduler_work"."spotify_album_id" is not null)
        or ("spotify_scheduler_work"."work_type" = 'release_tracks' and "spotify_scheduler_work"."spotify_album_id" is not null and "spotify_scheduler_work"."release_track_retrieval_id" is not null)
        or ("spotify_scheduler_work"."work_type" = 'track_resolution' and "spotify_scheduler_work"."artist_id" is not null and "spotify_scheduler_work"."expected_spotify_artist_id" is not null and "spotify_scheduler_work"."target_track_id" is not null and "spotify_scheduler_work"."target_isrc" is not null and "spotify_scheduler_work"."track_resolution_mode" is not null and ("spotify_scheduler_work"."track_resolution_mode" <> 'manual' or "spotify_scheduler_work"."target_spotify_track_id" is not null))
      ));
