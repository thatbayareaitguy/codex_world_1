import { decideArtistProviderIdentityStatus } from "@radar/db";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createProviderDatabaseServerContext } from "../../../../lib/provider-database-server";
import { assertSameOrigin, enforceRateLimit } from "../../../../lib/request-security";

const bodySchema = z
  .object({
    artistId: z.uuid(),
    linkedArtistId: z.uuid().optional(),
    provider: z.enum(["apple_music", "spotify"]),
    status: z.enum(["alias_or_duplicate", "confirmed_unavailable", "intentionally_excluded"]),
  })
  .superRefine((value, context) => {
    if (value.status === "alias_or_duplicate" && !value.linkedArtistId) {
      context.addIssue({
        code: "custom",
        message: "Alias or duplicate decisions require a canonical artist.",
        path: ["linkedArtistId"],
      });
    }
  });

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, 20);
    const body = bodySchema.parse(await request.json());
    const context = await createProviderDatabaseServerContext();
    try {
      const result = await decideArtistProviderIdentityStatus(context.db, {
        artistId: body.artistId,
        ...(body.linkedArtistId ? { linkedArtistId: body.linkedArtistId } : {}),
        provider: body.provider,
        status: body.status,
      });
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    } finally {
      await context.close();
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to save identity decision" },
      { status: 400 },
    );
  }
}
