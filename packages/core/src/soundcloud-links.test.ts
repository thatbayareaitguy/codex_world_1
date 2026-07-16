import { describe, expect, it } from "vitest";
import { buildSoundCloudSearchUrl, validateSoundCloudUrl } from "./soundcloud-links";

describe("SoundCloud outbound link safety", () => {
  it.each([
    "javascript:alert(1)",
    "data:text/html,bad",
    "file:///tmp/track",
    "http://soundcloud.com/artist/track",
    "https://soundcloud.example/artist/track",
    "https://soundcloud.com/search/sounds?q=track",
  ])("rejects unsafe or non-track URL %s", (url) => {
    expect(validateSoundCloudUrl(url, "track").valid).toBe(false);
  });

  it("accepts HTTPS SoundCloud profile and track URLs", () => {
    expect(validateSoundCloudUrl("https://soundcloud.com/artist-name", "profile").valid).toBe(true);
    expect(validateSoundCloudUrl("https://on.soundcloud.com/artist/track", "track").valid).toBe(
      true,
    );
  });

  it("builds an outbound search from canonical credits, title, and version", () => {
    const url = new URL(
      buildSoundCloudSearchUrl({
        artist: "Mara Voss",
        featuredArtists: ["Lumen Field"],
        title: "Soft Collision",
        version: "Radio Edit",
      }),
    );
    expect(url.origin).toBe("https://soundcloud.com");
    expect(url.searchParams.get("q")).toBe("Mara Voss Lumen Field Soft Collision Radio Edit");
  });
});
