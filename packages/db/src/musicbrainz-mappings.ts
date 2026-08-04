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
    return await decideArtistMapping(db, { ...input, provider: "musicbrainz" });
  } catch (error) {
    if (error instanceof ArtistMappingReviewNotFoundError) {
      throw new MusicBrainzMappingReviewNotFoundError();
    }
    throw error;
  }
}
