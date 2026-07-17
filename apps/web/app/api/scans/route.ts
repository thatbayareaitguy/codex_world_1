import { createDatabase, operationLocks, scanRuns } from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { and, desc, eq, gt } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { assertSameOrigin, enforceRateLimit } from "../../../lib/request-security";
import { launchScanNow } from "../../../lib/scan-launcher";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const configuration = loadProviderConfiguration();
  if (!configuration.databaseUrl) {
    return NextResponse.json({ error: "Database is not configured" }, { status: 503 });
  }
  const connection = createDatabase(configuration.databaseUrl);
  try {
    const [runs, activeScanLock] = await Promise.all([
      connection.db.select().from(scanRuns).orderBy(desc(scanRuns.startedAt)).limit(20),
      connection.db.query.operationLocks.findFirst({
        where: and(
          eq(operationLocks.lockKey, "scan:global"),
          gt(operationLocks.expiresAt, new Date()),
        ),
        columns: { lockKey: true },
      }),
    ]);
    return NextResponse.json(
      {
        latest: runs[0] ?? null,
        running: Boolean(activeScanLock || runs.some((run) => run.status === "running")),
        runs,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "Unable to load scan history" }, { status: 500 });
  } finally {
    await connection.client.end();
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, 3);
    const configuration = loadProviderConfiguration();
    if (!configuration.databaseUrl) {
      return NextResponse.json({ error: "Database is not configured" }, { status: 503 });
    }

    const connection = createDatabase(configuration.databaseUrl);
    try {
      const activeScanLock = await connection.db.query.operationLocks.findFirst({
        where: and(
          eq(operationLocks.lockKey, "scan:global"),
          gt(operationLocks.expiresAt, new Date()),
        ),
        columns: { lockKey: true },
      });
      if (activeScanLock) {
        return NextResponse.json({ error: "A scan is already running" }, { status: 409 });
      }
    } finally {
      await connection.client.end();
    }

    await launchScanNow();
    return NextResponse.json(
      { accepted: true },
      { headers: { "Cache-Control": "no-store" }, status: 202 },
    );
  } catch {
    return NextResponse.json({ error: "Unable to start the scan" }, { status: 500 });
  }
}
