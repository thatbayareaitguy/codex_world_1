import { describe, expect, it, vi } from "vitest";
import { AppleMusicIdentityCatalogClient } from "./apple-music-identity-catalog";

describe("Apple Music identity catalog enrichment", () => {
  it("uses only the supplied Apple ID and combines owned, appears-on, and top-song relationships", async () => {
    const getArtistViewFirstPage = vi.fn((_id: string, view: string) =>
      Promise.resolve({
        items: [album(view)],
        nextPresent: false,
      }),
    );
    const client = new AppleMusicIdentityCatalogClient({
      getArtist: vi.fn((id: string) =>
        Promise.resolve({
          artistId: id,
          genreNames: ["Electronic"],
          name: "Candidate Artist",
          sourceStorefront: "us",
        }),
      ),
      getArtistTopSongsFirstPage: vi.fn(() =>
        Promise.resolve({
          items: [
            {
              albumName: "Owned Release",
              artistIds: ["123", "999"],
              artistName: "Candidate Artist & Confirmed Collaborator",
              pageNumber: 1,
              paginationPath: "/top-songs",
              releaseDate: "2026-07-01",
              songId: "song-1",
              sourceStorefront: "us",
              title: "Distinct Song",
            },
          ],
          nextPresent: false,
        }),
      ),
      getArtistViewFirstPage,
      requestCount: 5,
    });

    const catalog = await client.getArtistCatalog("123");

    expect(catalog).toMatchObject({
      appleArtistId: "123",
      artistName: "Candidate Artist",
      genres: ["Electronic", "Dance"],
      labels: ["Candidate Records"],
      resourceStatus: "valid",
      source: "apple_music_api",
    });
    expect(catalog.releases.map((release) => release.appleReleaseId)).toEqual([
      "singles-release",
      "full-albums-release",
      "appears-on-albums-release",
    ]);
    expect(catalog.songs[0]?.artistIds).toEqual(["123", "999"]);
    expect(getArtistViewFirstPage.mock.calls.map((call) => call[1])).toEqual([
      "singles",
      "full-albums",
      "appears-on-albums",
    ]);
    expect(client.metrics.requests).toBe(5);
  });
});

function album(view: string) {
  return {
    albumId: `${view}-release`,
    artwork: {
      height: 300,
      url: "https://is1-ssl.mzstatic.com/image/thumb/Music221/example/{w}x{h}bb.jpg",
      width: 300,
    },
    artistIds: ["123"],
    artistName: "Candidate Artist",
    copyright: "Copyright Candidate Records",
    genreNames: ["Dance"],
    pageNumber: 1,
    paginationPath: `/view/${view}`,
    recordLabel: "Candidate Records",
    releaseDate: "2026-07-01",
    sourceStorefront: "us",
    sourceView: view as "singles",
    title: `${view} release`,
    trackCount: 4,
  };
}
