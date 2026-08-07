import { describe, expect, it } from "vitest";
import { loadProviderConfiguration } from "./config";

describe("provider configuration", () => {
  it("starts without credentials and hides manual SoundCloud links", () => {
    const config = loadProviderConfiguration({});

    expect(config.spotify).toMatchObject({
      enabled: true,
      configured: false,
      playlistWritesEnabled: false,
    });
    expect(config.spotify.allowedPlaylistId).toBeUndefined();
    expect(config.musicbrainz).toMatchObject({ enabled: false, configured: false });
    expect(config.soundcloudManualLinksEnabled).toBe(false);
    expect(config.reddit).toMatchObject({
      accessApproved: false,
      configured: false,
      enabled: false,
      includeComments: false,
      internalMaxQpm: 30,
    });
    expect(config.initialBackfillDays).toBe(60);
  });

  it("validates the single allowed Spotify playlist boundary", () => {
    const config = loadProviderConfiguration({
      SPOTIFY_ALLOWED_PLAYLIST_ID: "1234567890123456789012",
      SPOTIFY_PLAYLIST_WRITES_ENABLED: "true",
    });
    expect(config.spotify).toMatchObject({
      allowedPlaylistId: "1234567890123456789012",
      playlistWritesEnabled: true,
    });
    expect(() =>
      loadProviderConfiguration({ SPOTIFY_ALLOWED_PLAYLIST_ID: "not-a-playlist-id" }),
    ).toThrow();
  });

  it("validates typed feature flags", () => {
    const config = loadProviderConfiguration({
      APP_ENCRYPTION_KEY: "test-key",
      MUSICBRAINZ_CONTACT_EMAIL: "owner@example.test",
      MUSICBRAINZ_ENABLED: "false",
      SOUNDCLOUD_MANUAL_LINKS_ENABLED: "true",
      SPOTIFY_CLIENT_ID: "client",
      SPOTIFY_CLIENT_SECRET: "secret",
      SPOTIFY_ENABLED: "false",
    });

    expect(config.spotify).toMatchObject({ enabled: false, configured: false });
    expect(config.musicbrainz).toMatchObject({ enabled: false, configured: false });
    expect(config.soundcloudManualLinksEnabled).toBe(true);
  });

  it("requires an explicit flag and contact email to configure MusicBrainz", () => {
    const config = loadProviderConfiguration({
      MUSICBRAINZ_CONTACT_EMAIL: "owner@example.test",
      MUSICBRAINZ_ENABLED: "true",
    });

    expect(config.musicbrainz).toMatchObject({ enabled: true, configured: true });
  });

  it("requires approval, credentials, and a descriptive Reddit User-Agent", () => {
    const blocked = loadProviderConfiguration({
      REDDIT_ACCESS_APPROVED: "false",
      REDDIT_CLIENT_ID: "client",
      REDDIT_CLIENT_SECRET: "secret",
      REDDIT_ENABLED: "true",
      REDDIT_USER_AGENT: "node",
    });
    expect(blocked.reddit).toMatchObject({ configured: false, userAgentValid: false });

    const configured = loadProviderConfiguration({
      REDDIT_ACCESS_APPROVED: "true",
      REDDIT_CLIENT_ID: "client",
      REDDIT_CLIENT_SECRET: "secret",
      REDDIT_ENABLED: "true",
      REDDIT_USER_AGENT: "web:ts-new-music-radar:v0.1.0 (by /u/owner)",
    });
    expect(configured.reddit).toMatchObject({ configured: true, userAgentValid: true });
  });
});

describe("Spotify Development Mode configuration", () => {
  it("uses conservative defaults", () => {
    expect(loadProviderConfiguration({}).spotify).toMatchObject({
      artistsPerBatch: 15,
      batchPauseSeconds: 60,
      dailyMaxPagesPerArtist: 1,
      initialMaxPagesPerArtist: 2,
      maxConcurrency: 1,
      minRequestIntervalMs: 10_000,
      scanDistributionHours: 24,
      scheduler: {
        enabled: false,
        maxRequestsPerTick: 6,
        maxRuntimeMs: 90_000,
        rolling24HourLimit: 1_200,
        rolling30MinuteLimit: 30,
      },
    });
  });

  it.each([
    { SPOTIFY_MAX_CONCURRENCY: "0" },
    { SPOTIFY_MAX_CONCURRENCY: "2" },
    { SPOTIFY_MIN_REQUEST_INTERVAL_MS: "0" },
    { SPOTIFY_MIN_REQUEST_INTERVAL_MS: "9999" },
    { SPOTIFY_DAILY_MAX_PAGES_PER_ARTIST: "0" },
    { SPOTIFY_SCHEDULER_MAX_REQUESTS_PER_TICK: "7" },
    { SPOTIFY_SCHEDULER_MAX_RUNTIME_MS: "90001" },
    { SPOTIFY_SCHEDULER_ROLLING_30M_LIMIT: "0" },
  ])("rejects unsafe Spotify limits: %j", (environment) => {
    expect(() => loadProviderConfiguration(environment)).toThrow();
  });
});
