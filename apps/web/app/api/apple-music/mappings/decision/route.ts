import {
  ArtistMappingCandidateRequiredError,
  ArtistMappingReviewNotFoundError,
  decideArtistMapping,
} from "@radar/db";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createProviderDatabaseServerContext } from "../../../../../lib/provider-database-server";
import { assertSameOrigin, enforceRateLimit } from "../../../../../lib/request-security";

const bodySchema = z.object({
  decision: z.enum(["confirm", "reject", "restore"]),
  reviewId: z.uuid(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, 20);
    const body = bodySchema.parse(await request.json());
    const context = await createProviderDatabaseServerContext();
    try {
      const result = await decideArtistMapping(context.db, {
        ...body,
        provider: "apple_music",
      });
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    } finally {
      await context.close();
    }
  } catch (error) {
    if (error instanceof ArtistMappingReviewNotFoundError) {
      return NextResponse.json({ error: "Mapping review not found" }, { status: 404 });
    }
    if (error instanceof ArtistMappingCandidateRequiredError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: "Unable to save Apple Music mapping decision" },
      { status: 400 },
    );
  }
}
