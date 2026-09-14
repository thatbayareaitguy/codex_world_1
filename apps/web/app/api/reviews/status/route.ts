import { createDatabase, ensureLocalOwner, getReleaseReviewQueueStatus } from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { NextResponse } from "next/server";

export async function GET(): Promise<NextResponse> {
  const configuration = loadProviderConfiguration();
  if (!configuration.databaseUrl) {
    return NextResponse.json({ error: "Database is not configured" }, { status: 503 });
  }
  const connection = createDatabase(configuration.databaseUrl);
  try {
    const userId = await ensureLocalOwner(connection.db);
    const status = await getReleaseReviewQueueStatus(connection.db, userId);
    return NextResponse.json({ status });
  } finally {
    await connection.client.end();
  }
}
