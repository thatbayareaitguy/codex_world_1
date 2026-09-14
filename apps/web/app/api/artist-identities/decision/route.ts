import { decideArtistProviderIdentityStatus } from "@radar/db";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createProviderDatabaseServerContext } from "../../../../lib/provider-database-server";
import { assertSameOrigin, enforceRateLimit } from "../../../../lib/request-security";

const bodySchema = z
  .object({
    artistId: z.uuid(),
    externalIds: z
      .array(z.string().regex(/^\d{1,32}$/))
      .max(10)
      .optional(),
    linkedArtistId: z.uuid().optional(),
    provider: z.enum(["apple_music", "spotify"]),
    status: z.enum([
      "alias_or_duplicate",
      "confirmed_unavailable",
      "intentionally_deferred",
      "intentionally_excluded",
      "split_profile",
    ]),
  })
  .superRefine((value, context) => {
    if (value.status === "alias_or_duplicate" && !value.linkedArtistId) {
      context.addIssue({
        code: "custom",
        message: "Alias or duplicate decisions require a canonical artist.",
        path: ["linkedArtistId"],
      });
    }
    if (value.status === "split_profile" && (value.externalIds?.length ?? 0) < 2) {
      context.addIssue({
        code: "custom",
        message: "Select at least two Apple artist profiles.",
        path: ["externalIds"],
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
        ...(body.externalIds ? { externalIds: body.externalIds } : {}),
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
