import { createDatabase, ensureLocalOwner, updateFeedPreferences } from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, enforceRateLimit } from "../../../../lib/request-security";

const updateSchema = z
  .object({
    listened: z.boolean().optional(),
    saved: z.boolean().optional(),
  })
  .refine((value) => value.saved !== undefined || value.listened !== undefined);

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, 30);
    const input = updateSchema.parse(await request.json());
    const { id } = await context.params;
    const configuration = loadProviderConfiguration();
    if (!configuration.databaseUrl) {
      return NextResponse.json({ error: "Database is not configured" }, { status: 503 });
    }

    const connection = createDatabase(configuration.databaseUrl);
    try {
      const userId = await ensureLocalOwner(connection.db);
      const item = await updateFeedPreferences(connection.db, userId, id, {
        ...(input.listened !== undefined ? { listened: input.listened } : {}),
        ...(input.saved !== undefined ? { saved: input.saved } : {}),
      });
      if (!item) return NextResponse.json({ error: "Feed item not found" }, { status: 404 });
      return NextResponse.json({ item });
    } finally {
      await connection.client.end();
    }
  } catch {
    return NextResponse.json({ error: "Unable to update feed item" }, { status: 400 });
  }
}
