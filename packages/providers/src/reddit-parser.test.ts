import { describe, expect, it } from "vitest";
import {
  extractRedditLinks,
  matchRedditArtist,
  parseExplicitRedditDate,
  parseRedditRoundup,
  parseRedditTitle,
  redditCandidateHash,
  validateRedditEvidenceUrl,
  validateSubredditName,
} from "./reddit-parser";

describe("Reddit deterministic title parser", () => {
  it.each([
    ["Artist - Track", "Artist", "Track", "TRACK"],
    ["Artist \u2013 Track", "Artist", "Track", "TRACK"],
    ["Artist \u2014 Track", "Artist", "Track", "TRACK"],
    ["[FRESH] Artist - Track", "Artist", "Track", "TRACK"],
    ["New chune: Artist - Track", "Artist", "Track", "TRACK"],
    ["Artist - Track VIP", "Artist", "Track VIP", "TRACK"],
    ["Artist - Track Bootleg", "Artist", "Track Bootleg", "TRACK"],
    ["Artist - Track Edit", "Artist", "Track Edit", "TRACK"],
    ["Artist - Track Mashup", "Artist", "Track Mashup", "TRACK"],
    ["Artist - Track (Other Remix)", "Artist", "Track (Other Remix)", "REMIX"],
    ["Artist - Track Radio Edit", "Artist", "Track Radio Edit", "TRACK"],
    ["Artist - Track Extended Mix", "Artist", "Track Extended Mix", "DJ_MIX"],
    [
      "Artist - Track Live at Fixture Hall",
      "Artist",
      "Track Live at Fixture Hall",
      "LIVE_RECORDING",
    ],
    ["Artist - EP Title EP", "Artist", "EP Title EP", "EP"],
    ["Artist - Album Title LP", "Artist", "Album Title LP", "ALBUM"],
    ["Artist - Weekly DJ Mix", "Artist", "Weekly DJ Mix", "DJ_MIX"],
    ["Artist - Radio Show 12", "Artist", "Radio Show 12", "RADIO_SHOW"],
    ["Artist - Fixture Podcast", "Artist", "Fixture Podcast", "PODCAST"],
  ])("parses %s", (input, artist, title, classification) => {
    expect(parseRedditTitle(input)).toMatchObject({
      artistText: artist,
      classification,
      title,
    });
  });

  it("parses multiple primary artists", () => {
    expect(parseRedditTitle("Artist A, Artist B & Artist C x Artist D - Track")?.artists).toEqual([
      "Artist A",
      "Artist B",
      "Artist C",
      "Artist D",
    ]);
  });

  it("parses featured artists independently", () => {
    expect(parseRedditTitle("Artist - Track feat. Guest A & Guest B")?.credits).toEqual([
      { name: "Artist", role: "primary" },
      { name: "Guest A", role: "featured" },
      { name: "Guest B", role: "featured" },
    ]);
  });

  it("extracts a label without stripping version markers", () => {
    expect(parseRedditTitle("Artist - Track VIP [Fixture Label]")).toMatchObject({
      label: "Fixture Label",
      title: "Track VIP",
      version: "VIP",
    });
  });

  it("rejects prose without an artist-title separator", () => {
    expect(parseRedditTitle("What releases are you listening to?")).toBeUndefined();
  });

  it("bounds adversarial input", () => {
    const parsed = parseRedditTitle(`${"A".repeat(20_000)} - Track`);
    expect(parsed).toBeUndefined();
  });

  it("creates stable candidate hashes", () => {
    const candidate = parseRedditTitle("Artist - Track");
    expect(candidate).toBeDefined();
    expect(redditCandidateHash(candidate!)).toBe(redditCandidateHash(candidate!));
  });
});

describe("Reddit roundup parser", () => {
  const roundup = [
    "## Bass",
    "- Artist A - Track One [Label] | [Spotify](https://open.spotify.com/track/1234567890ABCDEFGHIJKL)",
    "- malformed prose entry",
    "- Artist B, Artist C - Track Two VIP | https://soundcloud.com/artist-b/track-two",
    "## House",
    "1. Artist D - Release EP",
  ].join("\n");

  it("extracts multiple independent release lines", () => {
    expect(parseRedditRoundup(roundup)).toHaveLength(3);
  });

  it("preserves section headings", () => {
    expect(parseRedditRoundup(roundup).map((item) => item.sectionHeading)).toEqual([
      "Bass",
      "Bass",
      "House",
    ]);
  });

  it("preserves source line numbers", () => {
    expect(parseRedditRoundup(roundup).map((item) => item.sourceLine)).toEqual([2, 4, 6]);
  });

  it("associates Markdown links with their release line", () => {
    expect(parseRedditRoundup(roundup)[0]?.links[0]?.category).toBe("spotify_track");
  });

  it("keeps SoundCloud links unverified", () => {
    expect(parseRedditRoundup(roundup)[1]?.links[0]).toMatchObject({
      category: "soundcloud",
      verified: false,
    });
  });

  it("does not let one malformed line fail the roundup", () => {
    expect(parseRedditRoundup(`${roundup}\n- [broken](javascript:alert(1))`)).toHaveLength(3);
  });

  it("limits document size and line count", () => {
    const lines = Array.from({ length: 400 }, (_, index) => `- Artist - Track ${index}`).join("\n");
    expect(parseRedditRoundup(lines).length).toBeLessThanOrEqual(250);
  });
});

describe("Reddit outbound URL security", () => {
  it.each([
    "javascript:alert(1)",
    "data:text/plain,unsafe",
    "file:///etc/passwd",
    "http://open.spotify.com/track/1234567890ABCDEFGHIJKL",
    "https://user:pass@example.com/path",
    "https://localhost/path",
    "https://127.0.0.1/path",
    "https://[::1]/path",
    "https://xn--soundclod-9za.example/path",
  ])("rejects unsafe URL %s", (value) => {
    expect(validateRedditEvidenceUrl(value).valid).toBe(false);
  });

  it("normalizes direct Spotify tracks and removes tracking parameters", () => {
    const result = validateRedditEvidenceUrl(
      "https://open.spotify.com/track/1234567890ABCDEFGHIJKL?si=synthetic#fragment",
    );
    expect(result).toMatchObject({
      valid: true,
      link: {
        category: "spotify_track",
        normalizedUrl: "https://open.spotify.com/track/1234567890ABCDEFGHIJKL",
      },
    });
  });

  it("classifies Spotify playlists without treating them as track proof", () => {
    const result = validateRedditEvidenceUrl(
      "https://open.spotify.com/playlist/1234567890ABCDEFGHIJKL",
    );
    expect(result).toMatchObject({ valid: true, link: { category: "spotify_playlist" } });
  });

  it("accepts a SoundCloud short host without resolving it", () => {
    expect(validateRedditEvidenceUrl("https://on.soundcloud.com/synthetic")).toMatchObject({
      valid: true,
      link: { category: "soundcloud", verified: false },
    });
  });

  it("extracts Markdown and bare HTTPS links", () => {
    expect(
      extractRedditLinks(
        "[Spotify](https://open.spotify.com/album/1234567890ABCDEFGHIJKL) https://example.test/store",
      ).map((link) => link.category),
    ).toEqual(["spotify_album", "other"]);
  });
});

describe("Reddit dates and artist matching", () => {
  it("parses an explicit ISO release date", () => {
    expect(parseExplicitRedditDate("Out 2026-07-24")).toMatchObject({
      confidence: "high",
      date: "2026-07-24",
    });
  });

  it("parses a named date", () => {
    expect(parseExplicitRedditDate("Releases July 24, 2026")).toMatchObject({
      confidence: "high",
      date: "2026-07-24",
    });
  });

  it("routes ambiguous numeric dates to review", () => {
    expect(parseExplicitRedditDate("Coming 07/08/2026")).toMatchObject({ confidence: "review" });
  });

  it("does not turn relative dates into exact dates", () => {
    expect(parseExplicitRedditDate("Out this Friday")).toEqual({
      confidence: "review",
      sourceText: "this Friday",
    });
  });

  const watchlist = [
    { id: "a1", name: "Lumen Field", aliases: ["Lumen"] },
    { id: "a2", name: "No" },
    { id: "a3", name: "Oxide Echo", spotifyNames: ["Oxide Echo Official"] },
  ];

  it("matches exact canonical artists", () => {
    expect(matchRedditArtist("Lumen Field", watchlist)).toMatchObject({
      artistId: "a1",
      confidence: 1,
      kind: "exact_canonical",
    });
  });

  it("matches exact confirmed aliases", () => {
    expect(matchRedditArtist("Lumen", watchlist)).toMatchObject({ kind: "exact_alias" });
  });

  it("matches exact confirmed provider names", () => {
    expect(matchRedditArtist("Oxide Echo Official", watchlist)).toMatchObject({
      kind: "exact_provider",
    });
  });

  it("requires review for ambiguous short names", () => {
    expect(matchRedditArtist("No", watchlist)).toMatchObject({ kind: "review" });
  });

  it("does not match artist substrings in unrelated words", () => {
    expect(matchRedditArtist("Lumenfielding", watchlist)).toMatchObject({ kind: "none" });
  });
});

describe("subreddit validation", () => {
  it.each(["EDM", "dubstep", "new_music_2026"])("accepts %s", (value) => {
    expect(validateSubredditName(value).valid).toBe(true);
  });

  it.each(["r/EDM/new", "../EDM", "EDM?sort=new", "https://reddit.com/r/EDM", "ab"])(
    "rejects %s",
    (value) => expect(validateSubredditName(value).valid).toBe(false),
  );
});
