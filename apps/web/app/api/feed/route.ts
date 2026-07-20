import { loadProviderConfiguration } from "@radar/providers";
import { NextResponse } from "next/server";
import { loadDatabaseFeedRevision, loadDatabaseFeedSnapshot } from "../../../lib/feed-server";

export async function GET(request: Request): Promise<NextResponse> {
  const configuration = loadProviderConfiguration();
  if (!configuration.databaseUrl) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  try {
    const revisionOnly = new URL(request.url).searchParams.get("mode") === "revision";
    const payload = revisionOnly
      ? await loadDatabaseFeedRevision(configuration.databaseUrl)
      : await loadDatabaseFeedSnapshot(configuration.databaseUrl);
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Unable to refresh the discovery feed" }, { status: 500 });
  }
}
