CREATE TABLE "feed_revisions" (
	"id" text PRIMARY KEY DEFAULT 'global' NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "feed_revisions" ("id", "revision", "item_count")
SELECT 'global', 1, count(*)::integer FROM "feed_items";
--> statement-breakpoint
CREATE FUNCTION "bump_feed_revision_row"() RETURNS trigger AS $$
DECLARE
	item_delta integer := 0;
BEGIN
	IF TG_OP = 'INSERT' THEN item_delta := 1;
	ELSIF TG_OP = 'DELETE' THEN item_delta := -1;
	END IF;
	INSERT INTO "feed_revisions" ("id", "revision", "item_count", "updated_at")
	VALUES ('global', 1, GREATEST(item_delta, 0), clock_timestamp())
	ON CONFLICT ("id") DO UPDATE SET
		"revision" = "feed_revisions"."revision" + 1,
		"item_count" = GREATEST(0, "feed_revisions"."item_count" + item_delta),
		"updated_at" = clock_timestamp();
	IF TG_OP = 'DELETE' THEN RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "bump_feed_revision_statement"() RETURNS trigger AS $$
BEGIN
	INSERT INTO "feed_revisions" ("id", "revision", "item_count", "updated_at")
	VALUES ('global', 1, 0, clock_timestamp())
	ON CONFLICT ("id") DO UPDATE SET
		"revision" = "feed_revisions"."revision" + 1,
		"updated_at" = clock_timestamp();
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "feed_items_revision_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "feed_items"
FOR EACH ROW EXECUTE FUNCTION "bump_feed_revision_row"();
--> statement-breakpoint
CREATE TRIGGER "release_candidates_feed_revision_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "release_candidates"
FOR EACH STATEMENT EXECUTE FUNCTION "bump_feed_revision_statement"();
--> statement-breakpoint
CREATE TRIGGER "source_evidence_feed_revision_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "source_evidence"
FOR EACH STATEMENT EXECUTE FUNCTION "bump_feed_revision_statement"();
--> statement-breakpoint
CREATE TRIGGER "tracks_feed_revision_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "tracks"
FOR EACH STATEMENT EXECUTE FUNCTION "bump_feed_revision_statement"();
--> statement-breakpoint
CREATE TRIGGER "track_credits_feed_revision_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "track_credits"
FOR EACH STATEMENT EXECUTE FUNCTION "bump_feed_revision_statement"();
--> statement-breakpoint
CREATE TRIGGER "track_availabilities_feed_revision_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "track_availabilities"
FOR EACH STATEMENT EXECUTE FUNCTION "bump_feed_revision_statement"();
--> statement-breakpoint
CREATE TRIGGER "releases_feed_revision_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "releases"
FOR EACH STATEMENT EXECUTE FUNCTION "bump_feed_revision_statement"();
--> statement-breakpoint
CREATE TRIGGER "release_external_ids_feed_revision_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "release_external_ids"
FOR EACH STATEMENT EXECUTE FUNCTION "bump_feed_revision_statement"();
--> statement-breakpoint
CREATE TRIGGER "release_track_appearances_feed_revision_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "release_track_appearances"
FOR EACH STATEMENT EXECUTE FUNCTION "bump_feed_revision_statement"();
--> statement-breakpoint
CREATE TRIGGER "release_track_sources_feed_revision_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "release_track_appearance_sources"
FOR EACH STATEMENT EXECUTE FUNCTION "bump_feed_revision_statement"();
--> statement-breakpoint
CREATE TRIGGER "playlist_exports_feed_revision_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "playlist_exports"
FOR EACH STATEMENT EXECUTE FUNCTION "bump_feed_revision_statement"();
--> statement-breakpoint
CREATE TRIGGER "spotify_release_tracks_feed_revision_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "spotify_release_track_retrievals"
FOR EACH STATEMENT EXECUTE FUNCTION "bump_feed_revision_statement"();
