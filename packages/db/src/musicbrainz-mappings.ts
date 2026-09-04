import { decideArtistMapping, ArtistMappingReviewNotFoundError } from "./provider-mappings";
import type { RadarDatabase } from "./client";

export class MusicBrainzMappingReviewNotFoundError extends ArtistMappingReviewNotFoundError {}

export async function decideMusicBrainzArtistMapping(
  db: RadarDatabase,
  input: { decision: "confirm" | "reject"; reviewId: string },
): Promise<{
  artistId: string;
  decision: "confirm" | "reject";
  externalId: string | null;
  idempotent: boolean;
}> {
  try {
    const result = await decideArtistMapping(db, { ...input, provider: "musicbrainz" });
    if (result.decision === "restore") {
      throw new Error("MusicBrainz restore decisions are not supported by this route.");
    }
    return {
      artistId: result.artistId,
      decision: result.decision,
      externalId: result.externalId,
      idempotent: result.idempotent,
    };
  } catch (error) {
    if (error instanceof ArtistMappingReviewNotFoundError) {
      throw new MusicBrainzMappingReviewNotFoundError();
    }
    throw error;
  }
}
