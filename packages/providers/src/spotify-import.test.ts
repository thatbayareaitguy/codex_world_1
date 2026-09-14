import { describe, expect, it } from "vitest";
import { createSpotifyImportPreview } from "./spotify-import";

const spotifyArtist = (id: string, name: string) => ({
  external_urls: { spotify: `https://open.spotify.com/artist/${id}` },
  id,
  images: [],
  name,
  type: "artist" as const,
  uri: `spotify:artist:${id}`,
});

describe("Spotify followed-artist import", () => {
  it("merges exact aliases, creates new artists, and flags collisions", () => {
    const preview = createSpotifyImportPreview(
      [
        spotifyArtist("one", "Night Index"),
        spotifyArtist("two", "New Artist"),
        spotifyArtist("three", "Collision"),
      ],
      [
        {
          aliases: ["Night Index"],
          id: "existing",
          manuallyEdited: true,
          name: "Night Index Ensemble",
        },
        { aliases: [], id: "collision-a", manuallyEdited: false, name: "Collision" },
        { aliases: ["Collision"], id: "collision-b", manuallyEdited: false, name: "Other" },
      ],
    );

    expect(preview).toMatchObject([
      { existingArtistId: "existing", proposedAction: "merge", selected: true },
      { proposedAction: "create", selected: true },
      { proposedAction: "review", selected: false },
    ]);
  });

  it("does not select a previously removed canonical artist for automatic reimport", () => {
    const preview = createSpotifyImportPreview(
      [spotifyArtist("removed", "Removed Artist")],
      [
        {
          aliases: [],
          id: "removed-canonical",
          manuallyEdited: false,
          name: "Removed Artist",
          selectedByDefault: false,
        },
      ],
    );

    expect(preview).toEqual([
      expect.objectContaining({
        existingArtistId: "removed-canonical",
        proposedAction: "merge",
        selected: false,
      }),
    ]);
  });
});
