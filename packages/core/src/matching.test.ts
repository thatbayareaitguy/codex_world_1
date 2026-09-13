import { describe, expect, it } from "vitest";
import {
  exactStableTrackIdentityRule,
  matchCandidate,
  normalizeText,
  primaryArtistCreditsOverlap,
} from "./index";
import type { CanonicalTrack, TrackCandidate } from "./types";

const candidate: TrackCandidate = {
  provider: "mock",
  externalReleaseId: "release-2",
  externalTrackId: "track-2",
  sourceLabel: "Mock catalog",
  artistExternalId: "artist-1",
  artistName: "Lumen Field",
  title: "Glass Horizon",
  releaseTitle: "Glass Horizon",
  releaseType: "single",
  releaseDate: "2026-07-11",
  releaseDatePrecision: "day",
  firstSeenAt: "2026-07-12T09:00:00.000Z",
  credits: [{ name: "Lumen Field", role: "primary" }],
  durationMs: 218000,
  isrc: "US-MCK-26-00001",
  region: "US",
  availability: "playable",
  providerUrl: "https://example.test/track-2",
  evidenceUrl: "https://example.test/evidence/track-2",
  evidenceType: "mock-fixture",
  payloadHash: "sha256:track-2",
};

const canonical: CanonicalTrack = {
  id: "canonical-1",
  title: "Glass Horizon",
  normalizedTitle: normalizeText("Glass Horizon"),
  credits: [{ name: "Lumen Field", role: "primary" }],
  durationMs: 218400,
  isrc: "USMCK2600001",
};

function candidateWithoutIsrc(): TrackCandidate {
  const copy = { ...candidate };
  delete copy.isrc;
  return copy;
}

describe("matchCandidate", () => {
  it("merges provider records with the same normalized ISRC", () => {
    expect(matchCandidate(candidate, [canonical])).toMatchObject({
      kind: "automatic",
      rule: "exact_isrc",
      confidence: 1,
      canonicalTrackId: "canonical-1",
    });
  });

  it("routes an incomplete metadata match to review", () => {
    const withoutIsrc: TrackCandidate = { ...candidate };
    delete withoutIsrc.isrc;
    const ambiguous = { ...withoutIsrc, durationMs: 226000 };
    expect(matchCandidate(ambiguous, [canonical])).toMatchObject({
      kind: "review",
      rule: "manual_review",
      confidence: 0.9,
    });
  });

  it("does not collapse conflicting versions", () => {
    const withoutIsrc: TrackCandidate = { ...candidate };
    delete withoutIsrc.isrc;
    const remix = { ...withoutIsrc, title: "Glass Horizon (Remix)" };
    const original = { ...canonical, normalizedTitle: normalizeText(remix.title), version: "live" };
    expect(matchCandidate(remix, [original])).toMatchObject({ kind: "review" });
  });

  it.each([
    ["Glass Horizon (Live)", "remix"],
    ["Glass Horizon (Clean)", "explicit"],
    ["Glass Horizon (Remaster)", "live"],
    ["Glass Horizon (Radio Edit)", "extended mix"],
  ])("keeps %s separate from a conflicting %s version", (title, existingVersion) => {
    const versioned: TrackCandidate = { ...candidate, title };
    delete versioned.isrc;
    const existing = {
      ...canonical,
      normalizedTitle: normalizeText(title),
      title,
      version: existingVersion,
    };
    expect(matchCandidate(versioned, [existing])).toMatchObject({
      kind: "review",
      rule: "manual_review",
    });
  });

  it("does not propose identical titles credited to unrelated primary artists", () => {
    const withoutIsrc: TrackCandidate = {
      ...candidate,
      credits: [{ name: "Another Artist", role: "primary" }],
    };
    delete withoutIsrc.isrc;
    expect(matchCandidate(withoutIsrc, [canonical])).toMatchObject({
      confidence: 1,
      kind: "new",
      rule: "new_canonical",
    });
  });

  it("still trusts an exact identifier when provider artist credits disagree", () => {
    expect(
      matchCandidate({ ...candidate, credits: [{ name: "Another Artist", role: "primary" }] }, [
        canonical,
      ]),
    ).toMatchObject({
      canonicalTrackId: "canonical-1",
      kind: "automatic",
      rule: "exact_isrc",
    });
  });

  it("requires matching featured credits for metadata automation", () => {
    const featuredCandidate: TrackCandidate = {
      ...candidate,
      credits: [
        { name: "Lumen Field", role: "primary" },
        { name: "Mara Voss", role: "featured" },
      ],
    };
    delete featuredCandidate.isrc;
    expect(matchCandidate(featuredCandidate, [canonical])).toMatchObject({ kind: "review" });
  });

  it("merges compilation appearances only when the ISRC is exact", () => {
    const compilationCandidate: TrackCandidate = {
      ...candidate,
      releaseTitle: "Summer Compilation",
      releaseType: "other",
    };
    expect(matchCandidate(compilationCandidate, [canonical])).toMatchObject({
      kind: "automatic",
      rule: "exact_isrc",
    });
  });

  it("does not collapse different tracks from the same MusicBrainz release group", () => {
    const releaseGroupCandidate: TrackCandidate = {
      ...candidateWithoutIsrc(),
      musicbrainzReleaseGroupId: "11111111-1111-4111-8111-111111111111",
      title: "Second Track",
      trackNumber: 2,
    };
    const releaseGroupTrack: CanonicalTrack = {
      ...canonical,
      musicbrainzReleaseGroupId: "11111111-1111-4111-8111-111111111111",
      title: "First Track",
      normalizedTitle: normalizeText("First Track"),
      trackNumber: 1,
    };
    expect(matchCandidate(releaseGroupCandidate, [releaseGroupTrack])).toMatchObject({
      kind: "new",
    });
  });

  it("matches a MusicBrainz release group only with the same position and title", () => {
    const releaseGroupCandidate: TrackCandidate = {
      ...candidateWithoutIsrc(),
      musicbrainzReleaseGroupId: "11111111-1111-4111-8111-111111111111",
      trackNumber: 1,
    };
    const releaseGroupTrack: CanonicalTrack = {
      ...canonical,
      musicbrainzReleaseGroupId: "11111111-1111-4111-8111-111111111111",
      trackNumber: 1,
    };
    expect(matchCandidate(releaseGroupCandidate, [releaseGroupTrack])).toMatchObject({
      kind: "automatic",
      rule: "exact_musicbrainz",
    });
  });
});

describe("primaryArtistCreditsOverlap", () => {
  it("normalizes primary names and ignores featured-credit differences", () => {
    expect(
      primaryArtistCreditsOverlap(
        [
          { name: "  Oliverse ", role: "primary" },
          { name: "Guest One", role: "featured" },
        ],
        [
          { name: "OLIVERSE", role: "primary" },
          { name: "Guest Two", role: "featured" },
        ],
      ),
    ).toBe(true);
  });

  it("rejects unrelated primary artist credits", () => {
    expect(
      primaryArtistCreditsOverlap(
        [{ name: "Oliverse", role: "primary" }],
        [{ name: "Maurizzle", role: "primary" }],
      ),
    ).toBe(false);
  });

  it("preserves legacy behavior when either side lacks a primary credit", () => {
    expect(
      primaryArtistCreditsOverlap(
        [{ name: "Oliverse", role: "primary" }],
        [{ name: "Maurizzle", role: "featured" }],
      ),
    ).toBe(true);
  });

  it("does not treat a symbol-only primary artist as an empty wildcard", () => {
    expect(
      primaryArtistCreditsOverlap(
        [{ name: "!!!", role: "primary" }],
        [{ name: "Maurizzle", role: "primary" }],
      ),
    ).toBe(false);
    expect(
      primaryArtistCreditsOverlap(
        [{ name: "！！！", role: "primary" }],
        [{ name: "!!!", role: "primary" }],
      ),
    ).toBe(true);
    expect(
      primaryArtistCreditsOverlap(
        [{ name: "   ", role: "primary" }],
        [{ name: "Maurizzle", role: "primary" }],
      ),
    ).toBe(false);
  });
});

describe("exactStableTrackIdentityRule", () => {
  it("uses current stable identifiers independently of persisted match metadata", () => {
    expect(
      exactStableTrackIdentityRule(
        {
          isrc: "US-MCK-26-00001",
          provider: "apple_music",
          externalTrackId: "apple-track-1",
          title: "Glass Horizon",
        },
        {
          isrc: "USMCK2600001",
          providerExternalIds: [],
          title: "Glass Horizon",
        },
      ),
    ).toBe("exact_isrc");
  });

  it("prefers an exact provider identity over other stable identifiers", () => {
    expect(
      exactStableTrackIdentityRule(
        {
          isrc: "US-MCK-26-00001",
          provider: "apple_music",
          externalTrackId: "apple-track-1",
          title: "Glass Horizon",
        },
        {
          isrc: "USMCK2600001",
          providerExternalIds: [{ externalId: "apple-track-1", provider: "apple_music" }],
          title: "Glass Horizon",
        },
      ),
    ).toBe("exact_provider_id");
  });
});
