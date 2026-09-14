CREATE TYPE "public"."discovery_schedule_job_status" AS ENUM('scheduled', 'leased', 'completed', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."discovery_schedule_job_type" AS ENUM('apple_full', 'apple_catchup');--> statement-breakpoint
ALTER TYPE "public"."spotify_scheduler_work_source" ADD VALUE 'apple_catchup';--> statement-breakpoint
CREATE TABLE "discovery_schedule_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_key" text NOT NULL,
	"job_type" "discovery_schedule_job_type" NOT NULL,
	"status" "discovery_schedule_job_status" DEFAULT 'scheduled' NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"recovery_deadline" timestamp with time zone NOT NULL,
	"apple_music_batch_id" uuid,
	"scan_run_id" uuid,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_classification" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discovery_schedule_jobs_window_check" CHECK ("discovery_schedule_jobs"."recovery_deadline" > "discovery_schedule_jobs"."scheduled_for"),
	CONSTRAINT "discovery_schedule_jobs_lease_check" CHECK (("discovery_schedule_jobs"."status" = 'leased' and "discovery_schedule_jobs"."lease_owner" is not null and "discovery_schedule_jobs"."lease_expires_at" is not null) or ("discovery_schedule_jobs"."status" <> 'leased' and "discovery_schedule_jobs"."lease_owner" is null and "discovery_schedule_jobs"."lease_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE "spotify_scheduler_daily_artists" (
	"local_date" date NOT NULL,
	"artist_id" uuid NOT NULL,
	"scheduler_work_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spotify_scheduler_daily_artists_local_date_artist_id_pk" PRIMARY KEY("local_date","artist_id")
);
--> statement-breakpoint
ALTER TABLE "discovery_schedule_jobs" ADD CONSTRAINT "discovery_schedule_jobs_apple_music_batch_id_apple_music_scan_batches_id_fk" FOREIGN KEY ("apple_music_batch_id") REFERENCES "public"."apple_music_scan_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_schedule_jobs" ADD CONSTRAINT "discovery_schedule_jobs_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spotify_scheduler_daily_artists" ADD CONSTRAINT "spotify_scheduler_daily_artists_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spotify_scheduler_daily_artists" ADD CONSTRAINT "spotify_scheduler_daily_artists_scheduler_work_id_spotify_scheduler_work_id_fk" FOREIGN KEY ("scheduler_work_id") REFERENCES "public"."spotify_scheduler_work"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_schedule_jobs_key_unique" ON "discovery_schedule_jobs" USING btree ("job_key");--> statement-breakpoint
CREATE INDEX "discovery_schedule_jobs_due_idx" ON "discovery_schedule_jobs" USING btree ("status","scheduled_for","recovery_deadline");--> statement-breakpoint
CREATE INDEX "discovery_schedule_jobs_lease_idx" ON "discovery_schedule_jobs" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE INDEX "spotify_scheduler_daily_artists_started_idx" ON "spotify_scheduler_daily_artists" USING btree ("local_date","started_at");