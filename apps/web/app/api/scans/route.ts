import { createDatabase, scanRuns } from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { desc } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function GET(): Promise<NextResponse> {
  const configuration = loadProviderConfiguration();
  if (!configuration.databaseUrl) {
    return NextResponse.json({ error: "Database is not configured" }, { status: 503 });
  }
  const connection = createDatabase(configuration.databaseUrl);
  try {
    const runs = await connection.db
      .select()
      .from(scanRuns)
      .orderBy(desc(scanRuns.startedAt))
      .limit(20);
    return NextResponse.json({ runs });
  } catch {
    return NextResponse.json({ error: "Unable to load scan history" }, { status: 500 });
  } finally {
    await connection.client.end();
  }
}
