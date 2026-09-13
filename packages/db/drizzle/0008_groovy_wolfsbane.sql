WITH ranked_feed_items AS (
	SELECT
		"id",
		min("first_seen_at") OVER (PARTITION BY "user_id", "track_id") AS "earliest_first_seen_at",
		row_number() OVER (
			PARTITION BY "user_id", "track_id"
			ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
		) AS "duplicate_rank"
	FROM "feed_items"
	WHERE "track_id" IS NOT NULL
		AND "state" <> 'needs_review'
)
UPDATE "feed_items"
SET "first_seen_at" = ranked_feed_items."earliest_first_seen_at"
FROM ranked_feed_items
WHERE "feed_items"."id" = ranked_feed_items."id"
	AND ranked_feed_items."duplicate_rank" = 1;--> statement-breakpoint
WITH ranked_feed_items AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "user_id", "track_id"
			ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
		) AS "duplicate_rank"
	FROM "feed_items"
	WHERE "track_id" IS NOT NULL
		AND "state" <> 'needs_review'
)
DELETE FROM "feed_items"
USING ranked_feed_items
WHERE "feed_items"."id" = ranked_feed_items."id"
	AND ranked_feed_items."duplicate_rank" > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "feed_user_track_unique" ON "feed_items" USING btree ("user_id","track_id") WHERE "feed_items"."track_id" is not null and "feed_items"."state" <> 'needs_review';
