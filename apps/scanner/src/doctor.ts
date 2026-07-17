import { createDatabase, getSpotifyOperationalStatus, operationLocks, scanRuns } from "@radar/db";
import { isValidRedditUserAgent, loadProviderConfiguration } from "@radar/providers";
import { desc, eq, inArray, sql } from "drizzle-orm";
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
  connected: boolean;
  failedScans: number;
  lastSuccessfulScan?: string;
  migrationCount: number;
  migrationError?: string;
  spotifyCooldownActive?: boolean;
  spotifyCooldownUntil?: string;
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
          : ready("Failed scans", "No failed scan runs are pending.", false),
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
      checks.push(
        ready(
          "Last successful scan",
          databaseStatus.lastSuccessfulScan ?? "No successful scan has been recorded yet.",
          false,
        ),
      );
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
    checks.push(...spotifyChecks(configuration, environment));
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
      ? ready("Application port", `TS New Music Radar is responding on 127.0.0.1:${port}.`)
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
  const lines = [`TS New Music Radar doctor`, `Overall: ${report.overall}`, ""];
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
    let lastSuccessfulScan: string | undefined;
    let staleLocks = 0;
    let spotifyCooldownActive = false;
    let spotifyCooldownUntil: string | undefined;
    try {
      const [failed] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(scanRuns)
        .where(inArray(scanRuns.status, ["failed", "partial"]));
      failedScans = failed?.count ?? 0;
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
    } catch {
      // Migration status already explains why operational tables cannot be read.
    }
    return {
      connected: true,
      failedScans,
      ...(lastSuccessfulScan ? { lastSuccessfulScan } : {}),
      migrationCount,
      ...(migrationError ? { migrationError } : {}),
      spotifyCooldownActive,
      ...(spotifyCooldownUntil ? { spotifyCooldownUntil } : {}),
      staleLocks,
    };
  } finally {
    await client.end();
  }
}

function spotifyChecks(
  configuration: ReturnType<typeof loadProviderConfiguration>,
  environment: NodeJS.ProcessEnv,
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
