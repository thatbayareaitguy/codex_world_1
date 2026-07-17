import { decideMusicBrainzArtistMapping, MusicBrainzMappingReviewNotFoundError } from "@radar/db";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createMusicBrainzServerContext } from "../../../../../lib/musicbrainz-server";
import { assertSameOrigin, enforceRateLimit } from "../../../../../lib/request-security";

const bodySchema = z.object({ decision: z.enum(["confirm", "reject"]), reviewId: z.uuid() });

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, 20);
    const body = bodySchema.parse(await request.json());
    const context = await createMusicBrainzServerContext();
    try {
      const result = await decideMusicBrainzArtistMapping(context.db, body);
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    } finally {
      await context.close();
    }
  } catch (error) {
    if (error instanceof MusicBrainzMappingReviewNotFoundError) {
      return NextResponse.json({ error: "Mapping review not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: "Unable to save MusicBrainz mapping decision" },
      { status: 400 },
    );
  }
}
