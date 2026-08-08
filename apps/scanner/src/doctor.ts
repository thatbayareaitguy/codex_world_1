import {
  createDatabase,
  getAppleMusicOperationalStatus,
  getSpotify429Telemetry,
  getSpotifyOperationalStatus,
  getSpotifySchedulerStatus,
  oauthAccounts,
  operationLocks,
  scanRuns,
  spotifyReleaseTrackCompletenessSummary,
  spotifySyncCampaigns,
} from "@radar/db";
import {
  hasSpotifyPlaylistWriteScopes,
  isValidRedditUserAgent,
  loadProviderConfiguration,
} from "@radar/providers";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { backupDirectory, logDirectory } from "./paths";

export type DoctorState = "READY" | "OPTIONAL_PROVIDER_DISABLED" | "ACTION_REQUIRED" | "ERROR";

export interface DoctorCheck {
  message: string;
  name: string;
  remediation?: string;
  required: boolean;
  state: DoctorState;
}

export interface DoctorDatabaseStatus {
  appleMusicCooldownActive?: boolean;
  appleMusicCooldownUntil?: string;
  appleMusicLeaseActive?: boolean;
  appleMusicRequestCount?: number;
  connected: boolean;
  failedScans: number;
  lastSuccessfulScan?: string;
  migrationCount: number;
  migrationError?: string;
  resolvedScans?: number;
  spotifyCooldownActive?: boolean;
  spotifyCooldownUntil?: string;
  spotifyGrantedScopes?: string[];
  spotifyRateLimits?: {
    allTime: Record<string, number>;
    historicalUnclassifiedCount: number;
    last24Hours: Record<string, number>;
    last30Minutes: Record<string, number>;
    latest: {
      classification: string;
      endpointCategory: string;
      observedAt: string;
      parsedRetryAfterSeconds: string | null;
      providerReasonToken: string | null;
      rawRetryAfter: string | null;
    } | null;
  };
  spotifyReleaseTracks?: {
    awaitingResume: number;
    completed: number;
    discrepancies: number;
    failed: number;
    missingTracks: number;
    partial: number;
  };
  spotifyScheduler?: {
    activeLease: boolean;
    artistAlbumsAllowance: number;
    artistAlbumsCalls: number;
    artistAlbumsPriorityReserve: number;
    blocked: number;
    mode: string;
    queued: number;
  };
  spotifySyncCampaign?: {
    activeReservations: number;
    leaseActive: boolean;
    leaseStale: boolean;
    status: string;
    successes: number;
    target: number;
  };
  staleLocks: number;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  generatedAt: string;
  overall: DoctorState;
}

export interface DoctorDependencies {
  databaseProbe?: (url: string) => Promise<DoctorDatabaseStatus>;
  directoryProbe?: (path: string) => boolean;
  expectedMigrationCount?: number;
  now?: () => Date;
  portProbe?: (port: number) => Promise<"available" | "application" | "occupied">;
  pnpmVersion?: string;
}

export async function collectDoctorReport(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: DoctorDependencies = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const now = dependencies.now?.() ?? new Date();
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(
    nodeMajor >= 22
      ? ready("Node", `Node ${process.versions.node} satisfies >=22.`)
      : error(
          "Node",
          `Node ${process.versions.node} is unsupported.`,
          "Install Node.js 22 or newer.",
        ),
  );

  const pnpmVersion =
    dependencies.pnpmVersion ??
    /pnpm\/([^\s]+)/.exec(environment.npm_config_user_agent ?? "")?.[1] ??
    "unknown";
  checks.push(
    pnpmVersion.startsWith("11.")
      ? ready("pnpm", `pnpm ${pnpmVersion} satisfies the required major version.`)
      : action(
          "pnpm",
          `pnpm ${pnpmVersion} does not confirm the required major version 11.`,
          "Run Corepack with the packageManager version declared in package.json.",
        ),
  );

  const databaseUrl = environment.DATABASE_URL;
  let databaseStatus: DoctorDatabaseStatus | undefined;
  if (!databaseUrl) {
    checks.push(action("Database URL", "DATABASE_URL is missing.", "Set DATABASE_URL in .env."));
  } else {
    checks.push(ready("Database URL", "DATABASE_URL is present and hidden."));
    try {
      databaseStatus = await (dependencies.databaseProbe ?? probeDatabase)(databaseUrl);
      if (!databaseStatus.connected) throw new Error("Database probe did not connect.");
      checks.push(ready("Database connection", "PostgreSQL connection succeeded."));
      const expected = dependencies.expectedMigrationCount ?? expectedMigrationCount();
      if (databaseStatus.migrationError) {
        checks.push(
          error(
            "Migrations",
            databaseStatus.migrationError,
            "Run pnpm db:migrate and inspect the migration error.",
          ),
        );
      } else if (databaseStatus.migrationCount < expected) {
        checks.push(
          action(
            "Migrations",
            `${expected - databaseStatus.migrationCount} migration(s) are pending.`,
            "Run pnpm db:migrate.",
          ),
        );
      } else {
        checks.push(
          ready("Migrations", `${databaseStatus.migrationCount} migrations are applied.`),
        );
      }
      checks.push(
        databaseStatus.failedScans > 0
          ? action(
              "Failed scans",
              `${databaseStatus.failedScans} scan run(s) require attention.`,
              "Run pnpm scan:status and retry the failed provider.",
              false,
            )
          : ready(
              "Failed scans",
              databaseStatus.resolvedScans
                ? `No failed scan runs are pending; ${databaseStatus.resolvedScans} resolved historical failure(s) are preserved.`
                : "No failed scan runs are pending.",
              false,
            ),
      );
      checks.push(
        databaseStatus.staleLocks > 0
          ? action(
              "Scan locks",
              `${databaseStatus.staleLocks} stale operation lock(s) were detected.`,
              "Run pnpm scan:unlock-stale after confirming no scan is running.",
            )
          : ready("Scan locks", "No stale operation locks were detected."),
      );
      checks.push(
        databaseStatus.spotifyCooldownActive
          ? action(
              "Spotify cooldown",
              databaseStatus.spotifyCooldownUntil
                ? `Spotify requests are blocked until ${databaseStatus.spotifyCooldownUntil}.`
                : "Spotify requests are blocked pending manual review.",
              "Wait for the provider cooldown. Do not probe or bypass it.",
              false,
            )
          : ready("Spotify cooldown", "No active Spotify cooldown was detected.", false),
      );
      if (databaseStatus.appleMusicCooldownActive !== undefined) {
        checks.push(
          databaseStatus.appleMusicCooldownActive
            ? action(
                "Apple Music cooldown",
                databaseStatus.appleMusicCooldownUntil
                  ? `Apple Music requests are blocked until ${databaseStatus.appleMusicCooldownUntil}.`
                  : "Apple Music requests are blocked pending manual review.",
                "Wait for the provider cooldown. Do not probe or bypass it.",
                false,
              )
            : ready(
                "Apple Music operations",
                `${databaseStatus.appleMusicRequestCount ?? 0} persisted requests; ${databaseStatus.appleMusicLeaseActive ? "one active lease" : "no active lease"}; no active cooldown.`,
                false,
              ),
        );
      }
      checks.push(
        ready(
          "Last successful scan",
          databaseStatus.lastSuccessfulScan ?? "No successful scan has been recorded yet.",
          false,
        ),
      );
      if (databaseStatus.spotifyReleaseTracks) {
        const albumTracks = databaseStatus.spotifyReleaseTracks;
        checks.push(
          ready(
            "Spotify album completeness",
            `${albumTracks.completed} complete; ${albumTracks.partial} partial; ${albumTracks.awaitingResume} awaiting resume; ${albumTracks.missingTracks} tracks missing; ${albumTracks.discrepancies} discrepancies.`,
            false,
          ),
        );
      }
      if (databaseStatus.spotifyRateLimits) {
        const telemetry = databaseStatus.spotifyRateLimits;
        const rolling = (counts: Record<string, number>) =>
          ["quota_exceeded", "unspecified_429", "unknown_reason", "legacy_unknown"]
            .map((classification) => `${classification}=${counts[classification] ?? 0}`)
            .join(", ");
        checks.push(
          ready(
            "Spotify 429 telemetry",
            telemetry.latest
              ? `Latest ${telemetry.latest.classification} at ${telemetry.latest.observedAt} on ${telemetry.latest.endpointCategory}; reason ${telemetry.latest.providerReasonToken ?? "none"}; Retry-After ${telemetry.latest.parsedRetryAfterSeconds ?? telemetry.latest.rawRetryAfter ?? "unavailable"}. Last 30 minutes: ${rolling(telemetry.last30Minutes)}. Last 24 hours: ${rolling(telemetry.last24Hours)}. All time: ${rolling(telemetry.allTime)}; ${telemetry.historicalUnclassifiedCount} historical unclassified.`
              : "No Spotify 429 request events are stored.",
            false,
          ),
        );
      }
      if (databaseStatus.spotifyScheduler) {
        const scheduler = databaseStatus.spotifyScheduler;
        checks.push(
          scheduler.activeLease
            ? action(
                "Spotify scheduler",
                `Mode ${scheduler.mode}; ${scheduler.queued} queued; ${scheduler.blocked} blocked; Artist Albums ${scheduler.artistAlbumsCalls}/${scheduler.artistAlbumsAllowance} with ${scheduler.artistAlbumsPriorityReserve} reserved; one active lease.`,
                "Confirm the bounded scheduler tick is still running before taking corrective action.",
                false,
              )
            : ready(
                "Spotify scheduler",
                `Mode ${scheduler.mode}; ${scheduler.queued} queued; ${scheduler.blocked} blocked; Artist Albums ${scheduler.artistAlbumsCalls}/${scheduler.artistAlbumsAllowance} with ${scheduler.artistAlbumsPriorityReserve} reserved; no active lease.`,
                false,
              ),
        );
      }
      if (databaseStatus.spotifySyncCampaign) {
        const campaign = databaseStatus.spotifySyncCampaign;
        checks.push(
          campaign.leaseStale
            ? action(
                "Spotify sync campaign",
                `${campaign.successes} of ${campaign.target} qualifying successes; stale campaign lease detected.`,
                "Confirm no campaign tick is active before allowing lease-expiry recovery.",
                false,
              )
            : ready(
                "Spotify sync campaign",
                `${campaign.status}; ${campaign.successes} of ${campaign.target} qualifying successes; ${campaign.activeReservations} active reservations; ${campaign.leaseActive ? "one active lease" : "no active lease"}.`,
                false,
              ),
        );
      }
    } catch (databaseError) {
      checks.push(
        error(
          "Database connection",
          safeDiagnosticError(databaseError),
          "Start PostgreSQL with pnpm db:up and verify DATABASE_URL.",
        ),
      );
    }
  }

  const encryptionKey = environment.APP_ENCRYPTION_KEY;
  const encryptionValid = encryptionKey
    ? Buffer.from(encryptionKey, "base64").length === 32
    : false;
  const spotifyExpected = environment.SPOTIFY_ENABLED !== "false";
  checks.push(
    encryptionValid
      ? ready(
          "Encryption key",
          "APP_ENCRYPTION_KEY is present and has the required decoded length.",
        )
      : action(
          "Encryption key",
          "APP_ENCRYPTION_KEY is missing or invalid.",
          "Generate a base64-encoded 32-byte key before connecting Spotify.",
          spotifyExpected,
        ),
  );

  let configuration: ReturnType<typeof loadProviderConfiguration> | undefined;
  try {
    configuration = loadProviderConfiguration(environment);
  } catch (configurationError) {
    checks.push(
      error(
        "Provider configuration",
        safeDiagnosticError(configurationError),
        "Correct invalid values in .env without adding quotes or unsupported values.",
      ),
    );
  }
  if (configuration) {
    checks.push(...appleMusicChecks(configuration));
    checks.push(...spotifyChecks(configuration, environment, databaseStatus));
    checks.push(
      configuration.discoverySchedulerEnabled
        ? ready(
            "Recurring discovery scheduler",
            "The bounded weekly Apple and Saturday-Wednesday Spotify scheduler is enabled.",
            false,
          )
        : optional(
            "Recurring discovery scheduler",
            "Recurring discovery execution is disabled by default.",
          ),
    );
    checks.push(...musicBrainzChecks(configuration));
    checks.push(...redditChecks(configuration, environment));
    checks.push(
      configuration.soundcloudManualLinksEnabled
        ? ready("SoundCloud manual links", "Manual outbound-link controls are enabled.", false)
        : optional("SoundCloud manual links", "Manual outbound-link controls are disabled."),
    );
  }

  const directoryProbe = dependencies.directoryProbe ?? isDirectoryWritable;
  for (const [name, path] of [
    ["Application logs", logDirectory(environment)],
    ["Database backups", backupDirectory(environment)],
  ] as const) {
    checks.push(
      directoryProbe(path)
        ? ready(name, `${path} is writable or can be created.`, false)
        : action(name, `${path} is not writable.`, "Set APP_DATA_DIR to a writable local path."),
    );
  }
  const backupMetadata = join(backupDirectory(environment), "last-backup.json");
  checks.push(
    ready(
      "Last backup",
      readLastBackup(backupMetadata) ?? "No completed backup has been recorded.",
      false,
    ),
  );

  const port = Number(environment.PORT ?? "3000");
  const portState = await (dependencies.portProbe ?? probePort)(port);
  checks.push(
    portState === "application"
      ? ready("Application port", `TS New Music Scanner is responding on 127.0.0.1:${port}.`)
      : portState === "available"
        ? ready("Application port", `Port ${port} is available on loopback.`)
        : error(
            "Application port",
            `Port ${port} is occupied by another process.`,
            "Stop the conflicting process or configure another local port.",
          ),
  );

  const requiredStates = checks.filter((check) => check.required).map((check) => check.state);
  const overall: DoctorState = requiredStates.includes("ERROR")
    ? "ERROR"
    : requiredStates.includes("ACTION_REQUIRED")
      ? "ACTION_REQUIRED"
      : "READY";
  return { checks, generatedAt: now.toISOString(), overall };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [`TS New Music Scanner doctor`, `Overall: ${report.overall}`, ""];
  for (const check of report.checks) {
    lines.push(`[${check.state}] ${check.name}: ${check.message}`);
    if (check.remediation) lines.push(`  Fix: ${check.remediation}`);
  }
  return lines.join("\n");
}

async function probeDatabase(url: string): Promise<DoctorDatabaseStatus> {
  const { db, client } = createDatabase(url);
  try {
    await client`select 1 as ok`;
    let migrationCount = 0;
    let migrationError: string | undefined;
    try {
      const rows = await client<{ count: number }[]>`
        select count(*)::int as count from drizzle.__drizzle_migrations
      `;
      migrationCount = rows[0]?.count ?? 0;
    } catch {
      migrationError = "The Drizzle migration table is missing.";
    }
    let failedScans = 0;
    let resolvedScans = 0;
    let lastSuccessfulScan: string | undefined;
    let staleLocks = 0;
    let spotifyCooldownActive = false;
    let spotifyCooldownUntil: string | undefined;
    let spotifyGrantedScopes: string[] | undefined;
    let spotifyReleaseTracks: DoctorDatabaseStatus["spotifyReleaseTracks"];
    let spotifyRateLimits: DoctorDatabaseStatus["spotifyRateLimits"];
    let spotifyScheduler: DoctorDatabaseStatus["spotifyScheduler"];
    let spotifySyncCampaign: DoctorDatabaseStatus["spotifySyncCampaign"];
    let appleMusicStatus: Awaited<ReturnType<typeof getAppleMusicOperationalStatus>> | undefined;
    try {
      const [failed] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(scanRuns)
        .where(
          sql`${scanRuns.status} in ('failed', 'partial') and coalesce(${scanRuns.metadata}->'resolution'->>'status', '') <> 'resolved'`,
        );
      failedScans = failed?.count ?? 0;
      const [resolved] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(scanRuns)
        .where(
          sql`${scanRuns.status} in ('failed', 'partial') and ${scanRuns.metadata}->'resolution'->>'status' = 'resolved'`,
        );
      resolvedScans = resolved?.count ?? 0;
      const [last] = await db
        .select({ completedAt: scanRuns.completedAt })
        .from(scanRuns)
        .where(eq(scanRuns.status, "completed"))
        .orderBy(desc(scanRuns.completedAt))
        .limit(1);
      lastSuccessfulScan = last?.completedAt?.toISOString();
      const [locks] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(operationLocks)
        .where(sql`${operationLocks.expiresAt} < now()`);
      staleLocks = locks?.count ?? 0;
      const spotify = await getSpotifyOperationalStatus(db);
      spotifyCooldownActive = spotify.cooldownActive;
      spotifyCooldownUntil = spotify.cooldownUntil?.toISOString();
      const spotifyAccount = await db.query.oauthAccounts.findFirst({
        columns: { scopes: true },
        where: and(eq(oauthAccounts.provider, "spotify"), isNull(oauthAccounts.disconnectedAt)),
      });
      spotifyGrantedScopes = spotifyAccount?.scopes;
      spotifyReleaseTracks = await spotifyReleaseTrackCompletenessSummary(db);
      const rateLimits = await getSpotify429Telemetry(db);
      spotifyRateLimits = {
        allTime: rateLimits.counts.allTime,
        historicalUnclassifiedCount: rateLimits.historicalUnclassifiedCount,
        last24Hours: rateLimits.counts.last24Hours,
        last30Minutes: rateLimits.counts.last30Minutes,
        latest: rateLimits.latest
          ? {
              ...rateLimits.latest,
              observedAt: rateLimits.latest.observedAt.toISOString(),
            }
          : null,
      };
      const scheduler = await getSpotifySchedulerStatus(db);
      spotifyScheduler = {
        activeLease: Boolean(scheduler.activeLease),
        artistAlbumsAllowance: scheduler.endpointBudget.artistAlbums.allowance,
        artistAlbumsCalls: scheduler.endpointBudget.artistAlbums.calls,
        artistAlbumsPriorityReserve: scheduler.endpointBudget.artistAlbums.priorityReserve,
        blocked: scheduler.blockedCount,
        mode: scheduler.mode,
        queued: Object.values(scheduler.backlog).reduce((total, value) => total + value, 0),
      };
      const campaign = await db.query.spotifySyncCampaigns.findFirst({
        where: sql`${spotifySyncCampaigns.status} in ('planned', 'running', 'canary_review', 'base_target_reached', 'draining', 'paused')`,
        orderBy: desc(spotifySyncCampaigns.createdAt),
      });
      if (campaign) {
        const current = new Date();
        spotifySyncCampaign = {
          activeReservations: campaign.activeReservationCount,
          leaseActive: Boolean(campaign.leaseExpiresAt && campaign.leaseExpiresAt > current),
          leaseStale: Boolean(campaign.leaseExpiresAt && campaign.leaseExpiresAt <= current),
          status: campaign.status,
          successes: campaign.qualifyingSuccessCount,
          target: campaign.targetSuccesses,
        };
      }
      if (migrationCount >= expectedMigrationCount()) {
        appleMusicStatus = await getAppleMusicOperationalStatus(db);
      }
    } catch {
      // Migration status already explains why operational tables cannot be read.
    }
    return {
      connected: true,
      ...(appleMusicStatus
        ? {
            appleMusicCooldownActive: appleMusicStatus.cooldownActive,
            ...(appleMusicStatus.cooldownUntil
              ? { appleMusicCooldownUntil: appleMusicStatus.cooldownUntil.toISOString() }
              : {}),
            appleMusicLeaseActive: appleMusicStatus.leaseActive,
            appleMusicRequestCount: appleMusicStatus.requestCount,
          }
        : {}),
      failedScans,
      ...(lastSuccessfulScan ? { lastSuccessfulScan } : {}),
      migrationCount,
      ...(migrationError ? { migrationError } : {}),
      resolvedScans,
      spotifyCooldownActive,
      ...(spotifyGrantedScopes ? { spotifyGrantedScopes } : {}),
      ...(spotifyReleaseTracks ? { spotifyReleaseTracks } : {}),
      ...(spotifyRateLimits ? { spotifyRateLimits } : {}),
      ...(spotifyScheduler ? { spotifyScheduler } : {}),
      ...(spotifySyncCampaign ? { spotifySyncCampaign } : {}),
      ...(spotifyCooldownUntil ? { spotifyCooldownUntil } : {}),
      staleLocks,
    };
  } finally {
    await client.end();
  }
}

function appleMusicChecks(
  configuration: ReturnType<typeof loadProviderConfiguration>,
): DoctorCheck[] {
  if (!configuration.appleMusic.enabled) {
    return [optional("Apple Music", "Apple Music catalog discovery is disabled.")];
  }
  const checks = [
    configuration.appleMusic.configured
      ? ready(
          "Apple Music configuration",
          "Apple Music catalog credentials are configured and hidden.",
        )
      : action(
          "Apple Music configuration",
          "Apple Music catalog credentials are incomplete.",
          "Set APPLE_MUSIC_TEAM_ID, APPLE_MUSIC_KEY_ID, and APPLE_MUSIC_PRIVATE_KEY_PATH.",
        ),
  ];
  if (configuration.appleMusic.privateKeyPath) {
    checks.push(
      existsSync(configuration.appleMusic.privateKeyPath)
        ? ready(
            "Apple Music private key",
            "The configured private-key file is available and hidden.",
          )
        : action(
            "Apple Music private key",
            "The configured private-key file is unavailable.",
            "Correct APPLE_MUSIC_PRIVATE_KEY_PATH without committing the key.",
          ),
    );
  }
  return checks;
}

function spotifyChecks(
  configuration: ReturnType<typeof loadProviderConfiguration>,
  environment: NodeJS.ProcessEnv,
  databaseStatus?: DoctorDatabaseStatus,
): DoctorCheck[] {
  if (!configuration.spotify.enabled) return [optional("Spotify", "Spotify is disabled.")];
  const checks = [
    environment.SPOTIFY_CLIENT_ID
      ? ready("Spotify client ID", "Spotify client ID is present and hidden.")
      : action("Spotify client ID", "Spotify client ID is missing.", "Set SPOTIFY_CLIENT_ID."),
    environment.SPOTIFY_CLIENT_SECRET
      ? ready("Spotify client secret", "Spotify client secret is present and hidden.")
      : action(
          "Spotify client secret",
          "Spotify client secret is missing.",
          "Set SPOTIFY_CLIENT_SECRET.",
        ),
  ];
  const redirect = configuration.spotify.redirectUri;
  checks.push(
    redirect === "http://127.0.0.1:3000/api/auth/spotify/callback"
      ? ready("Spotify redirect URI", "Spotify redirect URI matches the documented local callback.")
      : action(
          "Spotify redirect URI",
          "Spotify redirect URI does not match the documented 127.0.0.1 callback.",
          "Register and set http://127.0.0.1:3000/api/auth/spotify/callback.",
        ),
  );
  checks.push(
    configuration.spotify.scheduler.enabled
      ? ready(
          "Spotify scheduler capability",
          "The production scheduler capability is explicitly enabled.",
          false,
        )
      : optional(
          "Spotify scheduler capability",
          "Automatic Spotify scheduler execution is disabled by default.",
        ),
  );
  if (configuration.discoverySchedulerEnabled && !configuration.spotify.playlistWritesEnabled) {
    checks.push(
      action(
        "Automatic Spotify playlist export",
        "Recurring discovery is enabled, but Spotify playlist writes are disabled, so the playlist-inbox phase cannot advance.",
        "Set SPOTIFY_PLAYLIST_WRITES_ENABLED=true only after confirming the single allowed playlist and required scopes, or disable DISCOVERY_SCHEDULER_ENABLED.",
      ),
    );
  }
  checks.push(
    ready(
      "Spotify Artist Albums budget",
      `Trailing 24-hour limit ${configuration.spotify.artistAlbums24HourLimit}; ${configuration.spotify.artistAlbumsPriorityReserve} calls reserved for Apple-priority work; unused reserve may release after ${configuration.spotify.artistAlbumsReserveReleaseAfterHours} hours.`,
      false,
    ),
  );
  if (!configuration.spotify.playlistWritesEnabled) {
    checks.push(
      optional(
        "Spotify playlist writes",
        "Spotify playlist writes are disabled by default; no playlist mutation can run.",
      ),
    );
    checks.push(
      configuration.spotify.allowedPlaylistId
        ? ready("Spotify allowed playlist", "A valid allowed playlist ID is configured and hidden.")
        : optional(
            "Spotify allowed playlist",
            "No allowed playlist ID is configured; read-only Spotify features remain available.",
          ),
    );
  } else {
    checks.push(
      ready("Spotify playlist writes", "Spotify playlist additions are explicitly enabled."),
    );
    checks.push(
      configuration.spotify.allowedPlaylistId
        ? ready("Spotify allowed playlist", "A valid allowed playlist ID is configured and hidden.")
        : action(
            "Spotify allowed playlist",
            "Playlist writes are enabled without an allowed playlist ID.",
            "Set SPOTIFY_ALLOWED_PLAYLIST_ID or disable SPOTIFY_PLAYLIST_WRITES_ENABLED.",
          ),
    );
    checks.push(
      hasSpotifyPlaylistWriteScopes(databaseStatus?.spotifyGrantedScopes ?? [])
        ? ready(
            "Spotify playlist write scopes",
            "The connected account granted both required playlist modification scopes.",
          )
        : action(
            "Spotify playlist write scopes",
            "The connected account has not granted both required playlist modification scopes.",
            "Disconnect and reconnect Spotify with playlist writes enabled, then confirm both modification scopes.",
          ),
    );
  }
  return checks;
}

function musicBrainzChecks(
  configuration: ReturnType<typeof loadProviderConfiguration>,
): DoctorCheck[] {
  if (!configuration.musicbrainz.enabled)
    return [optional("MusicBrainz", "MusicBrainz is disabled.")];
  return [
    configuration.musicbrainz.contactEmail
      ? ready("MusicBrainz contact", "MusicBrainz contact email is configured and hidden.")
      : action(
          "MusicBrainz contact",
          "MusicBrainz contact email is missing.",
          "Set MUSICBRAINZ_CONTACT_EMAIL.",
        ),
  ];
}

function redditChecks(
  configuration: ReturnType<typeof loadProviderConfiguration>,
  environment: NodeJS.ProcessEnv,
): DoctorCheck[] {
  if (!configuration.reddit.enabled) {
    return [optional("Reddit", "Reddit is disabled; no Reddit request can occur.")];
  }
  return [
    configuration.reddit.accessApproved
      ? ready(
          "Reddit approval flag",
          "Reddit approval is recorded by the owner; this is not proof of approval.",
        )
      : action(
          "Reddit approval flag",
          "Reddit API approval required.",
          "Keep Reddit disabled until Reddit grants explicit access.",
        ),
    environment.REDDIT_CLIENT_ID && environment.REDDIT_CLIENT_SECRET
      ? ready("Reddit credentials", "Reddit credentials are present and hidden.")
      : action(
          "Reddit credentials",
          "Reddit credentials are missing.",
          "Configure approved credentials.",
        ),
    isValidRedditUserAgent(configuration.reddit.userAgent)
      ? ready("Reddit User-Agent", "Reddit User-Agent is descriptive and valid.")
      : action(
          "Reddit User-Agent",
          "Reddit User-Agent is missing or invalid.",
          "Use platform:app:version (by /u/contact).",
        ),
  ];
}

function expectedMigrationCount(): number {
  try {
    return readdirSync(resolve(process.cwd(), "packages", "db", "drizzle")).filter((name) =>
      /^\d{4}_.+\.sql$/.test(name),
    ).length;
  } catch {
    return 0;
  }
}

function isDirectoryWritable(path: string): boolean {
  let candidate = path;
  while (!existsSync(candidate) && dirname(candidate) !== candidate) candidate = dirname(candidate);
  try {
    accessSync(candidate, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function readLastBackup(path: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      "completedAt" in parsed &&
      typeof parsed.completedAt === "string"
    ) {
      return parsed.completedAt;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function probePort(port: number): Promise<"available" | "application" | "occupied"> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (response.ok) return "application";
  } catch {
    // A failed health request may mean the port is free.
  }
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise("occupied"));
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePromise("available")));
  });
}

function safeDiagnosticError(value: unknown): string {
  const message = value instanceof Error ? value.message : "Unknown diagnostic error";
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[DATABASE_URL REDACTED]")
    .replace(/(?:Bearer|Basic)\s+\S+/gi, "[AUTHORIZATION REDACTED]")
    .slice(0, 1_000);
}

function ready(name: string, message: string, required = true): DoctorCheck {
  return { message, name, required, state: "READY" };
}

function optional(name: string, message: string): DoctorCheck {
  return { message, name, required: false, state: "OPTIONAL_PROVIDER_DISABLED" };
}

function action(name: string, message: string, remediation: string, required = true): DoctorCheck {
  return { message, name, remediation, required, state: "ACTION_REQUIRED" };
}

function error(name: string, message: string, remediation: string): DoctorCheck {
  return { message, name, remediation, required: true, state: "ERROR" };
}
