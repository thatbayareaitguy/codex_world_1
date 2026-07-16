import { describe, expect, it } from "vitest";
import { matchCandidate, normalizeText } from "./index";
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

  it("does not merge identical titles credited to different artists", () => {
    const withoutIsrc: TrackCandidate = {
      ...candidate,
      credits: [{ name: "Another Artist", role: "primary" }],
    };
    delete withoutIsrc.isrc;
    expect(matchCandidate(withoutIsrc, [canonical])).toMatchObject({
      confidence: 0.7,
      kind: "review",
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
});
