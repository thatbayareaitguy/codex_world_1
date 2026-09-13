import { clearInvalidSpotifyCooldown, createDatabase } from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, enforceRateLimit } from "../../../../lib/request-security";

const clearSchema = z.object({
  confirmation: z.literal("CLEAR INVALID LOCAL COOLDOWN"),
  reason: z.string().trim().min(20).max(500),
});

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, 2);
    const input = clearSchema.parse(await request.json());
    const configuration = loadProviderConfiguration();
    if (!configuration.databaseUrl) {
      return NextResponse.json({ error: "Database is not configured" }, { status: 503 });
    }
    const connection = createDatabase(configuration.databaseUrl);
    try {
      const cleared = await clearInvalidSpotifyCooldown(connection.db, input.reason);
      return cleared
        ? NextResponse.json({ cleared: true })
        : NextResponse.json(
            { error: "The active cooldown is not eligible for local correction" },
            { status: 409 },
          );
    } finally {
      await connection.client.end();
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Confirmation and a specific reason are required" },
        {
          status: 400,
        },
      );
    }
    return NextResponse.json({ error: "Unable to clear the local cooldown" }, { status: 500 });
  }
}
