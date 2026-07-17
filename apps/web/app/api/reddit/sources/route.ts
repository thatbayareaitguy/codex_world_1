import { addRedditSource, createDatabase, ensureLocalOwner, listRedditSources } from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, enforceRateLimit } from "../../../../lib/request-security";

const sourceSchema = z.object({
  subreddit: z.string().trim().min(3).max(23),
});

export async function GET(): Promise<NextResponse> {
  const configuration = loadProviderConfiguration();
  if (!configuration.databaseUrl) {
    return NextResponse.json({ error: "Database is not configured" }, { status: 503 });
  }
  const connection = createDatabase(configuration.databaseUrl);
  try {
    const userId = await ensureLocalOwner(connection.db);
    const sources = await listRedditSources(connection.db, userId);
    return NextResponse.json({
      approvalRecorded: configuration.reddit.accessApproved,
      enabled: configuration.reddit.enabled,
      sources: sources.map((source) => ({
        enabled: source.enabled,
        id: source.id,
        lastError: source.lastError,
        lastSuccessfulScanAt: source.lastSuccessfulScanAt,
        subreddit: source.subreddit,
      })),
    });
  } catch {
    return NextResponse.json({ error: "Unable to load Reddit sources" }, { status: 500 });
  } finally {
    await connection.client.end();
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, 10);
    const input = sourceSchema.parse(await request.json());
    const configuration = loadProviderConfiguration();
    if (!configuration.databaseUrl) {
      return NextResponse.json({ error: "Database is not configured" }, { status: 503 });
    }
    const connection = createDatabase(configuration.databaseUrl);
    try {
      const userId = await ensureLocalOwner(connection.db);
      const source = await addRedditSource(connection.db, userId, input);
      return NextResponse.json({ source }, { status: 201 });
    } finally {
      await connection.client.end();
    }
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? "Enter a valid subreddit name."
        : "Unable to add Reddit source.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
