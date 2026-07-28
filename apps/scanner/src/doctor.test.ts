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
        MUSICBRAINZ_ENABLED: "false",
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
      report.checks.filter((check) => check.state === "OPTIONAL_PROVIDER_DISABLED"),
    ).toHaveLength(4);
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
        SPOTIFY_ALLOWED_PLAYLIST_ID: "1234567890123456789012",
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
    expect(output).not.toContain("1234567890123456789012");
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
            spotifyScheduler: { activeLease: false, blocked: 0, mode: "disabled", queued: 694 },
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
