import { loadProviderConfiguration } from "@radar/providers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { loadDatabaseFeedPage, loadDatabaseFeedRevision } from "../../../lib/feed-server";

const querySchema = z.object({
  artist: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().min(1).max(4096).optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  exactOnly: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(25).max(200).default(100),
  provider: z.enum(["apple_music", "mock", "musicbrainz", "reddit", "spotify"]).optional(),
  releaseType: z.string().trim().min(1).max(40).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  sort: z.enum(["release", "first-seen"]).default("release"),
  spotify: z.enum(["available", "unavailable"]).optional(),
  state: z.enum(["new", "upcoming", "saved", "dismissed", "listened", "needs_review"]).optional(),
});

export async function GET(request: Request): Promise<NextResponse> {
  const configuration = loadProviderConfiguration();
  if (!configuration.databaseUrl || !configuration.appEncryptionKey) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  try {
    const searchParams = new URL(request.url).searchParams;
    const revisionOnly = searchParams.get("mode") === "revision";
    if (revisionOnly) {
      const payload = await loadDatabaseFeedRevision(configuration.databaseUrl);
      return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
    }
    const query = querySchema.parse(Object.fromEntries(searchParams));
    const payload = await loadDatabaseFeedPage(configuration.databaseUrl, {
      ...(query.cursor ? { cursor: query.cursor } : {}),
      filters: {
        ...(query.artist ? { artist: query.artist } : {}),
        ...(query.dateFrom ? { dateFrom: query.dateFrom } : {}),
        ...(query.dateTo ? { dateTo: query.dateTo } : {}),
        ...(query.exactOnly ? { exactOnly: query.exactOnly === "true" } : {}),
        ...(query.provider ? { provider: query.provider } : {}),
        ...(query.releaseType ? { releaseType: query.releaseType } : {}),
        ...(query.search ? { search: query.search } : {}),
        sort: query.sort,
        ...(query.spotify ? { spotify: query.spotify } : {}),
        ...(query.state ? { state: query.state } : {}),
      },
      limit: query.limit,
      secret: configuration.appEncryptionKey,
    });
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (
      error instanceof z.ZodError ||
      (error instanceof Error && error.message.includes("cursor"))
    ) {
      return NextResponse.json({ error: "Invalid feed query" }, { status: 400 });
    }
    return NextResponse.json({ error: "Unable to refresh the discovery feed" }, { status: 500 });
  }
}
