import type { RadarDatabase } from "./client";
import { listArtistMappingReviewsPage, type ArtistMappingReviewPage } from "./provider-mappings";

export type MusicBrainzMappingReviewPage = ArtistMappingReviewPage;

export function listMusicBrainzMappingReviewsPage(
  db: RadarDatabase,
  options: { artistId?: string; cursor?: string; limit?: number } = {},
): Promise<MusicBrainzMappingReviewPage> {
  return listArtistMappingReviewsPage(db, { ...options, provider: "musicbrainz" });
}
