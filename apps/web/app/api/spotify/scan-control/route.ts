import {
  cancelSpotifyBatch,
  createDatabase,
  getSpotifyOperationalStatus,
  operationLocks,
  requestSpotifyBatchPause,
  resumeSpotifyBatch,
  retrySpotifyArtist,
  spotifyArtistScans,
} from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { and, eq, gt } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { launchScanNow } from "../../../../lib/scan-launcher";
import { assertSameOrigin, enforceRateLimit } from "../../../../lib/request-security";

const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause"), batchId: z.string().uuid() }),
  z.object({ action: z.literal("cancel"), batchId: z.string().uuid() }),
  z.object({ action: z.literal("resume"), batchId: z.string().uuid(), confirmed: z.literal(true) }),
  z.object({ action: z.literal("retry_artist"), artistScanId: z.string().uuid() }),
  z.object({ action: z.literal("start_reconciliation"), confirmed: z.literal(true) }),
]);

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, 5);
    const configuration = loadProviderConfiguration();
    if (!configuration.databaseUrl) {
      return NextResponse.json({ error: "Database is not configured" }, { status: 503 });
    }
    const input = requestSchema.parse(await request.json());
    const connection = createDatabase(configuration.databaseUrl);
    try {
      if (input.action === "pause") {
        const accepted = await requestSpotifyBatchPause(connection.db, input.batchId);
        return NextResponse.json({ accepted }, { status: accepted ? 202 : 409 });
      }
      if (input.action === "cancel") {
        const accepted = await cancelSpotifyBatch(connection.db, input.batchId);
        return NextResponse.json({ accepted }, { status: accepted ? 202 : 409 });
      }

      const operational = await getSpotifyOperationalStatus(connection.db);
      if (operational.cooldownActive) {
        return NextResponse.json(
          { error: "Spotify is in a provider-directed cooldown" },
          { status: 429 },
        );
      }
      const activeLock = await connection.db.query.operationLocks.findFirst({
        where: and(
          eq(operationLocks.lockKey, "scan:global"),
          gt(operationLocks.expiresAt, new Date()),
        ),
        columns: { lockKey: true },
      });
      if (activeLock) {
        return NextResponse.json({ error: "A scan is already running" }, { status: 409 });
      }

      if (input.action === "start_reconciliation") {
        await launchScanNow(undefined, process.env, process.cwd(), [
          "--provider",
          "spotify",
          "--spotify-mode",
          "reconciliation",
          "--confirm-spotify-batch",
        ]);
        return NextResponse.json({ accepted: true }, { status: 202 });
      }

      let batchId: string;
      if (input.action === "retry_artist") {
        const artistScan = await connection.db.query.spotifyArtistScans.findFirst({
          where: eq(spotifyArtistScans.id, input.artistScanId),
          columns: { batchId: true },
        });
        if (!artistScan || !(await retrySpotifyArtist(connection.db, input.artistScanId))) {
          return NextResponse.json({ error: "Artist scan is not retryable" }, { status: 409 });
        }
        batchId = artistScan.batchId;
        await resumeSpotifyBatch(connection.db, batchId);
      } else {
        batchId = input.batchId;
        if (!(await resumeSpotifyBatch(connection.db, batchId))) {
          return NextResponse.json({ error: "Batch is not resumable" }, { status: 409 });
        }
      }
      await launchScanNow(undefined, process.env, process.cwd(), [
        "--provider",
        "spotify",
        "--spotify-batch",
        batchId,
        "--confirm-spotify-batch",
      ]);
      return NextResponse.json({ accepted: true }, { status: 202 });
    } finally {
      await connection.client.end();
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid Spotify scan action" }, { status: 400 });
    }
    return NextResponse.json({ error: "Unable to update Spotify scan" }, { status: 500 });
  }
}
