import { sql } from "drizzle-orm";
import type { RadarDatabase } from "./client";

const PRODUCTION_TIME_ZONE = "America/Los_Angeles";

export type MatureReleasedFeedItemsResult = {
  maturedItemIds: string[];
  productionDate: string;
};

export function productionCalendarDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: PRODUCTION_TIME_ZONE,
    year: "numeric",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (!values.year || !values.month || !values.day) {
    throw new Error("Unable to calculate the production calendar date.");
  }
  return `${values.year}-${values.month}-${values.day}`;
}

export async function matureReleasedFeedItems(
  db: RadarDatabase,
  now = new Date(),
): Promise<MatureReleasedFeedItemsResult> {
  const productionDate = productionCalendarDate(now);
  const maturedRows = await db.execute<{ id: string }>(sql`
    update feed_items as feed
    set
      state = 'new'::feed_state,
      updated_at = ${now.toISOString()}::timestamptz
    where feed.state = 'upcoming'::feed_state
      and (
        exists (
          select 1
          from releases as release
          left join release_candidates as candidate on candidate.id = feed.candidate_id
          where release.id = coalesce(
            (
              select appearance.release_id
              from release_track_appearances as appearance
              where appearance.id = feed.appearance_id
            ),
            feed.release_id,
            (
              select track.release_id
              from tracks as track
              where track.id = feed.track_id
            )
          )
            and coalesce(release.release_date, candidate.release_date) <= ${productionDate}::date
        )
        or (
          feed.release_id is null
          and exists (
            select 1
            from release_candidates as candidate
            where candidate.id = feed.candidate_id
              and candidate.release_date <= ${productionDate}::date
          )
        )
        or exists (
          select 1
          from track_availabilities as availability
          where availability.track_id = feed.track_id
            and availability.provider = 'spotify'::provider
            and availability.region = 'US'
            and availability.state = 'playable'::availability_state
        )
      )
    returning feed.id
  `);

  return {
    maturedItemIds: maturedRows.map((row) => row.id),
    productionDate,
  };
}
