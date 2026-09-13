import { ArtistMappingExternalIdConflictError, confirmArtistMappingExternalId } from "@radar/db";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createProviderDatabaseServerContext } from "../../../../../lib/provider-database-server";
import { assertSameOrigin, enforceRateLimit } from "../../../../../lib/request-security";

const bodySchema = z.object({
  artistId: z.uuid(),
  externalId: z.string().regex(/^\d{1,32}$/),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, 20);
    const body = bodySchema.parse(await request.json());
    const context = await createProviderDatabaseServerContext();
    try {
      const result = await confirmArtistMappingExternalId(context.db, {
        ...body,
        provider: "apple_music",
      });
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    } finally {
      await context.close();
    }
  } catch (error) {
    if (error instanceof ArtistMappingExternalIdConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: "Unable to save the Apple Music artist ID" },
      { status: 400 },
    );
  }
}
