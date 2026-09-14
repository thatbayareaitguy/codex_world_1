import { describe, expect, it } from "vitest";
import {
  collectDirectAppleLinks,
  collectWikidataIds,
  fetchWikidataAppleArtistIds,
} from "./apple-identity-resolution-runner";

describe("exact independent Apple identity links", () => {
  it("extracts only exact Apple artist URLs and Wikidata entities", () => {
    const relationships = [
      relationship("https://music.apple.com/us/artist/example/123"),
      relationship("https://www.wikidata.org/wiki/Q456"),
      relationship("https://example.com/artist/999"),
    ];
    expect([...collectDirectAppleLinks(relationships)]).toEqual([["123", "musicbrainz_url"]]);
    expect(collectWikidataIds(relationships)).toEqual(["Q456"]);
  });

  it("reads only exact P2850 Apple artist IDs from the linked Wikidata entity", async () => {
    const ids = await fetchWikidataAppleArtistIds("Q456", () =>
      Promise.resolve(
        Response.json({
          entities: {
            Q456: {
              claims: {
                P2850: [
                  { mainsnak: { datavalue: { value: "123" } } },
                  { mainsnak: { datavalue: { value: "789" } } },
                ],
              },
            },
          },
        }),
      ),
    );
    expect(ids).toEqual(["123", "789"]);
  });
});

function relationship(resource: string) {
  return { type: "other databases", url: { resource } };
}
