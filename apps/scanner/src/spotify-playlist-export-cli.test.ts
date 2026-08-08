import { describe, expect, it } from "vitest";
import {
  parseSpotifyPlaylistExportOptions,
  sanitizedSpotifyPlaylistExportOutput,
} from "./spotify-playlist-export-cli";

describe("Spotify playlist export CLI", () => {
  it("requires one explicit mode and accepts a bounded live canary", () => {
    expect(parseSpotifyPlaylistExportOptions(["--", "--dry-run"])).toEqual({
      discoveryInbox: false,
      live: false,
    });
    expect(parseSpotifyPlaylistExportOptions(["--live", "--max-additions", "3"])).toEqual({
      discoveryInbox: false,
      live: true,
      maxAdditions: 3,
    });
    expect(parseSpotifyPlaylistExportOptions(["--live", "--max-additions=10"])).toEqual({
      discoveryInbox: false,
      live: true,
      maxAdditions: 10,
    });
  });

  it("accepts a campaign-scoped discovery inbox without accepting a playlist ID", () => {
    expect(
      parseSpotifyPlaylistExportOptions([
        "--live",
        "--campaign",
        "5f462e9e-c3db-451c-b77c-378ab21e8a94",
        "--discovery-inbox",
      ]),
    ).toEqual({
      campaignId: "5f462e9e-c3db-451c-b77c-378ab21e8a94",
      discoveryInbox: true,
      live: true,
    });
    expect(() => parseSpotifyPlaylistExportOptions(["--live", "--discovery-inbox"])).toThrow(
      "requires --campaign",
    );
  });

  it("rejects ambiguous, unsafe, and browser-supplied target options", () => {
    expect(() => parseSpotifyPlaylistExportOptions([])).toThrow("exactly one");
    expect(() => parseSpotifyPlaylistExportOptions(["--dry-run", "--live"])).toThrow("exactly one");
    expect(() => parseSpotifyPlaylistExportOptions(["--dry-run", "--max-additions", "1"])).toThrow(
      "only with --live",
    );
    expect(() => parseSpotifyPlaylistExportOptions(["--live", "--playlist-id", "other"])).toThrow(
      "Unknown",
    );
  });

  it("reports exact target actions and per-item reasons without accepting a target argument", () => {
    const output = sanitizedSpotifyPlaylistExportOutput({
      plan: {
        additions: [
          {
            confidence: 1,
            desiredOrdinal: 0,
            discNumber: 1,
            feedItemId: "feed-add",
            feedState: "new",
            followedArtist: true,
            manuallyConfirmed: false,
            matchRule: "exact_isrc",
            position: 4,
            providerTrackId: "0000000000000000000001",
            reason: "missing_from_playlist",
            releaseDate: "2026-08-04",
            releaseId: "release-add",
            releaseTitle: "Release",
            releaseType: "single",
            title: "Track",
            trackId: "track-add",
            trackNumber: 1,
          },
        ],
        alreadyPresent: [],
        desired: [],
        existingDuplicateTrackIds: [],
        finalTrackIds: [],
        orderingConflicts: [],
        releaseGroupingConflicts: [],
        skips: [
          {
            feedItemId: "feed-skip",
            reason: "uncertain_spotify_match",
            title: "Uncertain",
            trackId: "track-skip",
          },
        ],
        unrelatedItems: [
          {
            artistNames: ["User Artist"],
            position: 2,
            releaseDate: "2020-01-01",
            reason: "not_in_export_set",
            title: "User Track",
            trackId: "9999999999999999999999",
          },
        ],
      },
      target: {
        id: "1234567890123456789012",
        name: "Release Inbox",
        snapshotId: "snapshot",
      },
    });

    expect(output).toMatchObject({
      additions: [{ position: 4, reason: "missing_from_playlist" }],
      skips: [{ reason: "uncertain_spotify_match", title: "Uncertain" }],
      target: { id: "1234567890123456789012" },
      unrelatedItems: [
        {
          artistNames: ["User Artist"],
          position: 2,
          releaseDate: "2020-01-01",
          title: "User Track",
          trackId: "9999999999999999999999",
        },
      ],
    });
  });
});
