import { artistMappingReviews } from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { createMusicBrainzServerContext } from "../../../../lib/musicbrainz-server";

export async function GET(): Promise<NextResponse> {
  const config = loadProviderConfiguration();
  if (!config.musicbrainz.enabled) return NextResponse.json({ state: "disabled" });
  if (!config.musicbrainz.configured || !config.databaseUrl) {
    return NextResponse.json({ state: "missing_configuration" });
  }
  const context = await createMusicBrainzServerContext();
  try {
    const pending = await context.db.query.artistMappingReviews.findMany({
      where: eq(artistMappingReviews.status, "pending"),
      columns: { id: true },
    });
    return NextResponse.json({ mappingReviewCount: pending.length, state: "ready" });
  } finally {
    await context.close();
  }
}
