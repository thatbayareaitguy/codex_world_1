import { createDatabase } from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, enforceRateLimit } from "../../../../lib/request-security";

const bodySchema = z.object({ confirmation: z.literal("DELETE ALL DATA") });

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, 2);
    bodySchema.parse(await request.json());
    const configuration = loadProviderConfiguration();
    if (!configuration.databaseUrl) {
      return NextResponse.json({ error: "Database is not configured" }, { status: 503 });
    }
    const connection = createDatabase(configuration.databaseUrl);
    try {
      await connection.db.execute(sql`
        truncate table
          users,
          artists,
          releases,
          tracks,
          scan_runs,
          provider_cursors,
          scan_locks,
          provider_cache
        restart identity cascade
      `);
      return NextResponse.json({ deleted: true });
    } finally {
      await connection.client.end();
    }
  } catch {
    return NextResponse.json({ error: "Application data deletion failed" }, { status: 400 });
  }
}
