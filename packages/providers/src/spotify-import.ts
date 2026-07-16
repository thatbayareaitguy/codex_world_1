import { normalizeText } from "@radar/core";
import type { SpotifyArtist } from "./spotify";

export interface CanonicalArtistImportTarget {
  aliases: string[];
  id: string;
  manuallyEdited: boolean;
  name: string;
}

export interface SpotifyImportPreviewItem {
  existingArtistId?: string;
  proposedAction: "create" | "merge" | "review";
  providerArtistId: string;
  providerName: string;
  providerUrl: string;
  selected: boolean;
}

export function createSpotifyImportPreview(
  spotifyArtists: SpotifyArtist[],
  canonicalArtists: CanonicalArtistImportTarget[],
): SpotifyImportPreviewItem[] {
  return spotifyArtists.map((spotifyArtist) => {
    const normalized = normalizeText(spotifyArtist.name);
    const matches = canonicalArtists.filter((artist) =>
      [artist.name, ...artist.aliases].some((name) => normalizeText(name) === normalized),
    );
    if (matches.length === 1) {
      return {
        existingArtistId: matches[0]!.id,
        proposedAction: "merge",
        providerArtistId: spotifyArtist.id,
        providerName: spotifyArtist.name,
        providerUrl: spotifyArtist.external_urls.spotify,
        selected: true,
      };
    }
    if (matches.length > 1) {
      return {
        proposedAction: "review",
        providerArtistId: spotifyArtist.id,
        providerName: spotifyArtist.name,
        providerUrl: spotifyArtist.external_urls.spotify,
        selected: false,
      };
    }
    return {
      proposedAction: "create",
      providerArtistId: spotifyArtist.id,
      providerName: spotifyArtist.name,
      providerUrl: spotifyArtist.external_urls.spotify,
      selected: true,
    };
  });
}
