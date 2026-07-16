CREATE TYPE "public"."external_link_state" AS ENUM('NOT_CHECKED', 'SEARCH_LINK_AVAILABLE', 'USER_LINKED_UNVERIFIED', 'USER_LINKED_VERIFIED', 'USER_LINK_REJECTED');--> statement-breakpoint
CREATE TYPE "public"."external_link_type" AS ENUM('artist_profile', 'track');--> statement-breakpoint
CREATE TABLE "external_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"artist_id" uuid,
	"track_id" uuid,
	"service" text NOT NULL,
	"link_type" "external_link_type" NOT NULL,
	"url" text NOT NULL,
	"state" "external_link_state" NOT NULL,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_links_exactly_one_target_check" CHECK ((case when "external_links"."artist_id" is null then 0 else 1 end + case when "external_links"."track_id" is null then 0 else 1 end) = 1),
	CONSTRAINT "external_links_soundcloud_https_check" CHECK ("external_links"."service" <> 'soundcloud' or "external_links"."url" ~ '^https://([a-z0-9-]+\.)*soundcloud\.com/')
);
--> statement-breakpoint
ALTER TABLE "external_links" ADD CONSTRAINT "external_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_links" ADD CONSTRAINT "external_links_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_links" ADD CONSTRAINT "external_links_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_links" ADD CONSTRAINT "external_links_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_links_user_artist_service_unique" ON "external_links" USING btree ("user_id","artist_id","service","link_type") WHERE "external_links"."artist_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "external_links_user_track_service_unique" ON "external_links" USING btree ("user_id","track_id","service","link_type") WHERE "external_links"."track_id" is not null;--> statement-breakpoint
CREATE INDEX "external_links_verified_collection_idx" ON "external_links" USING btree ("user_id","service","state");