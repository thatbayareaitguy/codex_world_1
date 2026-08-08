import { describe, expect, it } from "vitest";
import { collectDoctorReport, formatDoctorReport } from "./doctor";

const databaseReady = {
  connected: true,
  failedScans: 0,
  lastSuccessfulScan: "2026-07-15T12:00:00.000Z",
  migrationCount: 6,
  staleLocks: 0,
};

describe("doctor", () => {
  it("is ready when required services work and optional providers are disabled", async () => {
    const report = await collectDoctorReport(
      {
        APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
        DATABASE_URL: "postgresql://secret:secret@127.0.0.1:5432/radar",
        REDDIT_ENABLED: "false",
        SOUNDCLOUD_MANUAL_LINKS_ENABLED: "false",
        SPOTIFY_ENABLED: "false",
      },
      {
        databaseProbe: () => Promise.resolve(databaseReady),
        directoryProbe: () => true,
        expectedMigrationCount: 6,
        pnpmVersion: "11.9.0",
        portProbe: () => Promise.resolve("available"),
      },
    );
    expect(report.overall).toBe("READY");
    expect(
      report.checks
        .filter((check) => check.state === "OPTIONAL_PROVIDER_DISABLED")
        .map((check) => check.name),
    ).toEqual([
      "Apple Music",
      "Spotify",
      "Recurring discovery scheduler",
      "MusicBrainz",
      "Reddit",
      "SoundCloud manual links",
    ]);
  });

  it("does not require an encryption key when Spotify is explicitly disabled", async () => {
    const report = await collectDoctorReport(
      {
        DATABASE_URL: "postgresql://secret:secret@127.0.0.1:5432/radar",
        MUSICBRAINZ_ENABLED: "false",
        REDDIT_ENABLED: "false",
        SPOTIFY_ENABLED: "false",
      },
      {
        databaseProbe: () => Promise.resolve(databaseReady),
        directoryProbe: () => true,
        expectedMigrationCount: 6,
        pnpmVersion: "11.9.0",
        portProbe: () => Promise.resolve("available"),
      },
    );
    expect(report.overall).toBe("READY");
    expect(report.checks.find((check) => check.name === "Encryption key")?.required).toBe(false);
  });

  it("reports the default Spotify playlist write boundary without exposing an ID", async () => {
    const report = await collectDoctorReport(
      {
        DATABASE_URL: "postgresql://secret:secret@127.0.0.1:5432/radar",
        MUSICBRAINZ_ENABLED: "false",
        REDDIT_ENABLED: "false",
        SPOTIFY_ALLOWED_PLAYLIST_ID: "4l6LaMPL6duulmFe3hRR4Y",
        SPOTIFY_PLAYLIST_WRITES_ENABLED: "false",
      },
      {
        databaseProbe: () => Promise.resolve(databaseReady),
        directoryProbe: () => true,
        expectedMigrationCount: 6,
        pnpmVersion: "11.9.0",
        portProbe: () => Promise.resolve("available"),
      },
    );
    const output = formatDoctorReport(report);
    expect(output).toContain("Spotify playlist writes are disabled by default");
    expect(output).toContain("Automatic Spotify scheduler execution is disabled by default");
    expect(output).toContain("Recurring discovery execution is disabled by default");
    expect(output).not.toContain("4l6LaMPL6duulmFe3hRR4Y");
  });

  it("requires playlist writes when recurring discovery execution is enabled", async () => {
    const report = await collectDoctorReport(
      {
        APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
        DATABASE_URL: "postgresql://secret:secret@127.0.0.1:5432/radar",
        DISCOVERY_SCHEDULER_ENABLED: "true",
        MUSICBRAINZ_ENABLED: "false",
        REDDIT_ENABLED: "false",
        SPOTIFY_CLIENT_ID: "client-id",
        SPOTIFY_CLIENT_SECRET: "client-secret",
        SPOTIFY_ENABLED: "true",
        SPOTIFY_PLAYLIST_WRITES_ENABLED: "false",
        SPOTIFY_REDIRECT_URI: "http://127.0.0.1:3000/api/auth/spotify/callback",
      },
      {
        databaseProbe: () => Promise.resolve(databaseReady),
        directoryProbe: () => true,
        expectedMigrationCount: 6,
        pnpmVersion: "11.9.0",
        portProbe: () => Promise.resolve("available"),
      },
    );

    expect(
      report.checks.find((check) => check.name === "Automatic Spotify playlist export"),
    ).toMatchObject({ state: "ACTION_REQUIRED" });
  });

  it("requires both Spotify playlist modification scopes when writes are enabled", async () => {
    const baseEnvironment = {
      APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      DATABASE_URL: "postgresql://secret:secret@127.0.0.1:5432/radar",
      MUSICBRAINZ_ENABLED: "false",
      REDDIT_ENABLED: "false",
      SPOTIFY_ALLOWED_PLAYLIST_ID: "4l6LaMPL6duulmFe3hRR4Y",
      SPOTIFY_CLIENT_ID: "client-id",
      SPOTIFY_CLIENT_SECRET: "client-secret",
      SPOTIFY_ENABLED: "true",
      SPOTIFY_PLAYLIST_WRITES_ENABLED: "true",
      SPOTIFY_REDIRECT_URI: "http://127.0.0.1:3000/api/auth/spotify/callback",
    };
    const dependencies = {
      directoryProbe: () => true,
      expectedMigrationCount: 6,
      pnpmVersion: "11.9.0",
      portProbe: () => Promise.resolve<"available">("available"),
    };
    const privateOnly = await collectDoctorReport(baseEnvironment, {
      ...dependencies,
      databaseProbe: () =>
        Promise.resolve({
          ...databaseReady,
          spotifyGrantedScopes: ["playlist-modify-private"],
        }),
    });
    expect(
      privateOnly.checks.find((check) => check.name === "Spotify playlist write scopes"),
    ).toMatchObject({ state: "ACTION_REQUIRED" });

    const dualScope = await collectDoctorReport(baseEnvironment, {
      ...dependencies,
      databaseProbe: () =>
        Promise.resolve({
          ...databaseReady,
          spotifyGrantedScopes: ["playlist-modify-private", "playlist-modify-public"],
        }),
    });
    expect(
      dualScope.checks.find((check) => check.name === "Spotify playlist write scopes"),
    ).toMatchObject({ state: "READY" });
  });

  it("reports scheduler database state without treating a disabled scheduler as unhealthy", async () => {
    const report = await collectDoctorReport(
      {
        DATABASE_URL: "postgresql://secret:secret@127.0.0.1:5432/radar",
        MUSICBRAINZ_ENABLED: "false",
        REDDIT_ENABLED: "false",
        SPOTIFY_ENABLED: "false",
      },
      {
        databaseProbe: () =>
          Promise.resolve({
            ...databaseReady,
            discoverySchedule: {
              pendingPlaylistOperations: 3,
              phase: "playlist_inbox",
              playlistInboxStatus: "ready",
            },
            spotifyScheduler: {
              activeLease: false,
              artistAlbumsAllowance: 80,
              artistAlbumsCalls: 60,
              artistAlbumsPriorityReserve: 20,
              artistAlbumsReserveRemaining: 20,
              blocked: 0,
              mode: "disabled",
              playlistReads: 2,
              playlistWrites: 1,
              queued: 694,
            },
          }),
        directoryProbe: () => true,
        expectedMigrationCount: 6,
        pnpmVersion: "11.9.0",
        portProbe: () => Promise.resolve("available"),
      },
    );
    expect(report.checks.find((check) => check.name === "Spotify scheduler")).toMatchObject({
      required: false,
      state: "READY",
    });
    expect(report.checks.find((check) => check.name === "Spotify scheduler")?.message).toContain(
      "priority reserve 20/20 remaining",
    );
    expect(report.checks.find((check) => check.name === "Spotify scheduler")?.message).toContain(
      "playlist requests 2 read/1 write",
    );
    expect(report.checks.find((check) => check.name === "Automatic playlist inbox")?.message).toBe(
      "Phase playlist_inbox; status ready; 3 pending operation(s).",
    );
  });

  it("reports bounded Spotify 429 classifications without raw response content", async () => {
    const report = await collectDoctorReport(
      {
        DATABASE_URL: "postgresql://secret:secret@127.0.0.1:5432/radar",
        MUSICBRAINZ_ENABLED: "false",
        REDDIT_ENABLED: "false",
        SPOTIFY_ENABLED: "false",
      },
      {
        databaseProbe: () =>
          Promise.resolve({
            ...databaseReady,
            spotifyRateLimits: {
              allTime: {
                legacy_unknown: 1,
                quota_exceeded: 2,
                unknown_reason: 0,
                unspecified_429: 1,
              },
              historicalUnclassifiedCount: 1,
              last24Hours: {
                legacy_unknown: 0,
                quota_exceeded: 1,
                unknown_reason: 0,
                unspecified_429: 0,
              },
              last30Minutes: {
                legacy_unknown: 0,
                quota_exceeded: 1,
                unknown_reason: 0,
                unspecified_429: 0,
              },
              latest: {
                classification: "quota_exceeded",
                endpointCategory: "artist_albums",
                observedAt: "2026-07-27T20:00:00.000Z",
                parsedRetryAfterSeconds: "60",
                providerReasonToken: "QUOTA_EXCEEDED",
                rawRetryAfter: "60",
              },
            },
          }),
        directoryProbe: () => true,
        expectedMigrationCount: 6,
        pnpmVersion: "11.9.0",
        portProbe: () => Promise.resolve("available"),
      },
    );
    const output = formatDoctorReport(report);
    expect(output).toContain("Latest quota_exceeded");
    expect(output).toContain("reason QUOTA_EXCEEDED");
    expect(output).toContain("legacy_unknown=1");
    expect(output).not.toContain("provider response body");
  });

  it("reports migrations and stale locks as actionable", async () => {
    const report = await collectDoctorReport(
      {
        APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
        DATABASE_URL: "postgresql://secret:secret@127.0.0.1:5432/radar",
        MUSICBRAINZ_ENABLED: "false",
        REDDIT_ENABLED: "false",
        SPOTIFY_ENABLED: "false",
      },
      {
        databaseProbe: () =>
          Promise.resolve({ ...databaseReady, migrationCount: 5, staleLocks: 1 }),
        directoryProbe: () => true,
        expectedMigrationCount: 6,
        pnpmVersion: "11.9.0",
        portProbe: () => Promise.resolve("available"),
      },
    );
    expect(report.overall).toBe("ACTION_REQUIRED");
    expect(report.checks.find((check) => check.name === "Migrations")?.remediation).toContain(
      "pnpm db:migrate",
    );
    expect(report.checks.find((check) => check.name === "Scan locks")?.remediation).toContain(
      "scan:unlock-stale",
    );
  });

  it("distinguishes resolved historical scan failures from pending failures", async () => {
    const report = await collectDoctorReport(
      {
        DATABASE_URL: "postgresql://secret:secret@127.0.0.1:5432/radar",
        MUSICBRAINZ_ENABLED: "false",
        REDDIT_ENABLED: "false",
        SPOTIFY_ENABLED: "false",
      },
      {
        databaseProbe: () =>
          Promise.resolve({ ...databaseReady, failedScans: 0, resolvedScans: 1 }),
        directoryProbe: () => true,
        expectedMigrationCount: 6,
        pnpmVersion: "11.9.0",
        portProbe: () => Promise.resolve("available"),
      },
    );
    const failedScanCheck = report.checks.find((check) => check.name === "Failed scans");
    expect(failedScanCheck).toMatchObject({ state: "READY" });
    expect(failedScanCheck?.message).toContain("1 resolved historical failure");
  });

  it("redacts database credentials from failures", async () => {
    const report = await collectDoctorReport(
      { DATABASE_URL: "postgresql://owner:private@127.0.0.1:5432/radar" },
      {
        databaseProbe: () =>
          Promise.reject(new Error("failed postgresql://owner:private@127.0.0.1:5432/radar")),
        directoryProbe: () => true,
        pnpmVersion: "11.9.0",
        portProbe: () => Promise.resolve("available"),
      },
    );
    const output = formatDoctorReport(report);
    expect(output).not.toContain("private");
    expect(output).toContain("[DATABASE_URL REDACTED]");
  });
});
