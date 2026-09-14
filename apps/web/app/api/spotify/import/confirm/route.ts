import { confirmSpotifyImport } from "@radar/db";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertSameOrigin, enforceRateLimit } from "../../../../../lib/request-security";
import { createSpotifyServerContext } from "../../../../../lib/spotify-server";

const bodySchema = z.object({
  decisions: z.array(
    z.object({
      candidateId: z.uuid(),
      decision: z.enum(["create", "merge", "skip"]),
      existingArtistId: z.uuid().optional(),
      selected: z.boolean(),
    }),
  ),
  importRunId: z.uuid(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, 10);
    const body = bodySchema.parse(await request.json());
    const context = await createSpotifyServerContext();
    try {
      const summary = await confirmSpotifyImport(
        context.db,
        context.userId,
        body.importRunId,
        body.decisions.map((decision) => ({
          candidateId: decision.candidateId,
          decision: decision.decision,
          ...(decision.existingArtistId ? { existingArtistId: decision.existingArtistId } : {}),
          selected: decision.selected,
        })),
      );
      revalidatePath("/");
      return NextResponse.json(summary);
    } finally {
      await context.close();
    }
  } catch {
    return NextResponse.json(
      { error: "Unable to confirm followed-artist import" },
      { status: 400 },
    );
  }
}
