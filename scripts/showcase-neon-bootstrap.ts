import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import postgres, { type Sql } from "postgres";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(
  scriptDirectory,
  "..",
  "apps",
  "showcase",
  "neon",
  "0001_public_catalog.sql",
);
const publisherRole = "showcase_publisher";
const websiteRole = "showcase_web_readonly";
let operationStage = "startup";

interface LocalCredentialPaths {
  readonly owner: string;
  readonly publisher: string;
  readonly website: string;
}

interface RoleConnectionStrings {
  readonly publisher: string;
  readonly website: string;
}

interface ApplicationRoleState {
  readonly rolname: string;
  readonly hasElevatedPrivilege: boolean;
}

interface PermissionVerification {
  readonly publisherCanReadCurrentCatalog: boolean;
  readonly publisherCanPublishThroughFunction: boolean;
  readonly publisherCannotWriteBaseTable: boolean;
  readonly publisherCannotCreateInShowcaseSchema: boolean;
  readonly publisherRoleIsUnprivileged: boolean;
  readonly publisherConnectionLimitIsBounded: boolean;
  readonly websiteCanReadCurrentCatalog: boolean;
  readonly websiteCannotReadBaseTable: boolean;
  readonly websiteCannotPublish: boolean;
  readonly websiteRoleIsUnprivileged: boolean;
  readonly websiteConnectionLimitIsBounded: boolean;
  readonly rollbackPublishProbePassed: boolean;
}

class SafeBootstrapError extends Error {}

function localCredentialPaths(): LocalCredentialPaths {
  const localData = process.env.LOCALAPPDATA;
  if (localData === undefined || localData.trim() === "") {
    throw new SafeBootstrapError("LOCALAPPDATA is required for local Showcase credentials.");
  }
  const directory = resolve(localData, "Showcase");
  return {
    owner: resolve(directory, "neon-owner.env"),
    publisher: resolve(directory, "neon-publisher.env"),
    website: resolve(directory, "neon-public-web.env"),
  };
}

export function readEnvValue(source: string, variableName: string): string {
  const prefix = `${variableName}=`;
  const line = source
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) throw new SafeBootstrapError(`${variableName} is missing.`);
  const rawValue = line.slice(prefix.length).trim();
  const value =
    rawValue.length >= 2 &&
    ((rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'")))
      ? rawValue.slice(1, -1)
      : rawValue;
  if (value.trim() === "") throw new SafeBootstrapError(`${variableName} is empty.`);
  return value;
}

function validateOwnerUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SafeBootstrapError("The Showcase Neon owner database URL is invalid.");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new SafeBootstrapError("The Showcase Neon owner URL must use PostgreSQL.");
  }
  if (!parsed.hostname.toLowerCase().endsWith(".neon.tech")) {
    throw new SafeBootstrapError("The Showcase Neon owner URL must target Neon.");
  }
  if (parsed.hostname.toLowerCase().includes("-pooler")) {
    throw new SafeBootstrapError("The owner bootstrap requires a direct Neon connection URL.");
  }
  if (parsed.searchParams.get("sslmode") !== "require") {
    throw new SafeBootstrapError("The Showcase Neon owner URL must require TLS.");
  }
  if (parsed.pathname.replaceAll("/", "").trim() === "") {
    throw new SafeBootstrapError("The Showcase Neon owner URL must name a database.");
  }
  return parsed;
}

function pooledHostname(hostname: string): string {
  const [endpoint, ...suffix] = hostname.split(".");
  if (endpoint === undefined || suffix.length === 0) {
    throw new SafeBootstrapError("The Neon hostname cannot be converted to a pooled endpoint.");
  }
  return `${endpoint.endsWith("-pooler") ? endpoint : `${endpoint}-pooler`}.${suffix.join(".")}`;
}

export function deriveRoleConnectionStrings(
  ownerValue: string,
  publisherPassword: string,
  websitePassword: string,
): RoleConnectionStrings {
  const owner = validateOwnerUrl(ownerValue);
  const publisher = new URL(owner);
  publisher.username = publisherRole;
  publisher.password = publisherPassword;

  const website = new URL(owner);
  website.hostname = pooledHostname(website.hostname);
  website.username = websiteRole;
  website.password = websitePassword;

  return { publisher: publisher.toString(), website: website.toString() };
}

function randomPassword(): string {
  return randomBytes(48).toString("base64url");
}

function databaseClient(connectionString: string): Sql {
  return postgres(connectionString, {
    connect_timeout: 15,
    idle_timeout: 5,
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
}

async function applicationRoleStates(owner: Sql): Promise<ApplicationRoleState[]> {
  const rows = await owner<
    {
      rolname: string;
      has_elevated_privilege: boolean;
    }[]
  >`
    SELECT
      rolname,
      rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
        AS has_elevated_privilege
    FROM pg_roles
    WHERE rolname IN (${publisherRole}, ${websiteRole})
    ORDER BY rolname
  `;
  return rows.map((row) => ({
    rolname: row.rolname,
    hasElevatedPrivilege: row.has_elevated_privilege,
  }));
}

async function applyBootstrap(
  ownerUrl: string,
  publisherPassword: string,
  websitePassword: string,
  rotate: boolean,
): Promise<void> {
  const owner = databaseClient(ownerUrl);
  try {
    operationStage = "owner-role-check";
    const existing = await applicationRoleStates(owner);
    if (existing.length > 0 && !rotate) {
      throw new SafeBootstrapError(
        "Showcase application roles already exist. Use --rotate only for an intentional credential rotation.",
      );
    }
    if (existing.some((role) => role.hasElevatedPrivilege)) {
      throw new SafeBootstrapError(
        "An existing Showcase application role has elevated privileges; rotation was refused.",
      );
    }
    const [ownerCapabilities] = await owner<
      { can_create_role: boolean; can_set_neon_superuser: boolean }[]
    >`
      SELECT
        rolcreaterole AS can_create_role,
        pg_has_role(current_user, 'neon_superuser', 'SET') AS can_set_neon_superuser
      FROM pg_roles
      WHERE rolname = current_user
    `;
    if (ownerCapabilities === undefined) {
      throw new SafeBootstrapError("The Neon owner role capabilities could not be verified.");
    }
    if (!ownerCapabilities.can_create_role && !ownerCapabilities.can_set_neon_superuser) {
      throw new SafeBootstrapError(
        "The Neon owner login cannot create SQL roles or assume neon_superuser.",
      );
    }
    operationStage = "owner-schema-transaction";
    await owner.begin(async (transaction) => {
      operationStage = "owner-password-session";
      await transaction`SET LOCAL password_encryption = 'scram-sha-256'`;
      await transaction`SELECT set_config('showcase.bootstrap.publisher_password', ${publisherPassword}, true)`;
      await transaction`SELECT set_config('showcase.bootstrap.website_password', ${websitePassword}, true)`;
      if (ownerCapabilities.can_set_neon_superuser) {
        await transaction`SET LOCAL ROLE neon_superuser`;
      }
      operationStage = "owner-schema-role-ddl";
      await transaction.unsafe(`
        DO $showcase_schema_role$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'showcase_schema_owner') THEN
            CREATE ROLE showcase_schema_owner
              NOLOGIN
              NOSUPERUSER
              NOCREATEDB
              NOCREATEROLE
              NOINHERIT
              NOREPLICATION
              NOBYPASSRLS;
          END IF;
        END
        $showcase_schema_role$;
      `);

      operationStage = "owner-publisher-role-ddl";
      await transaction.unsafe(`
        DO $showcase_publisher_role$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${publisherRole}') THEN
            EXECUTE format(
              'ALTER ROLE ${publisherRole} PASSWORD %L',
              current_setting('showcase.bootstrap.publisher_password')
            );
          ELSE
            EXECUTE format(
              'CREATE ROLE ${publisherRole} LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3',
              current_setting('showcase.bootstrap.publisher_password')
            );
          END IF;
        END
        $showcase_publisher_role$;
      `);

      operationStage = "owner-website-role-ddl";
      await transaction.unsafe(`
        DO $showcase_website_role$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${websiteRole}') THEN
            EXECUTE format(
              'ALTER ROLE ${websiteRole} PASSWORD %L',
              current_setting('showcase.bootstrap.website_password')
            );
          ELSE
            EXECUTE format(
              'CREATE ROLE ${websiteRole} LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20',
              current_setting('showcase.bootstrap.website_password')
            );
          END IF;
        END
        $showcase_website_role$;
      `);

      operationStage = "owner-application-role-connection-limits";
      await transaction.unsafe(`
        ALTER ROLE ${publisherRole} CONNECTION LIMIT 3;
        ALTER ROLE ${websiteRole} CONNECTION LIMIT 20;
      `);

      operationStage = "owner-schema-owner-membership";
      await transaction.unsafe(`
        GRANT showcase_schema_owner TO SESSION_USER WITH ADMIN OPTION;
      `);

      operationStage = "owner-application-role-settings";
      await transaction.unsafe(`
        ALTER ROLE ${publisherRole} SET search_path = showcase, pg_catalog;
        ALTER ROLE ${websiteRole} SET search_path = showcase, pg_catalog;
      `);
      if (ownerCapabilities.can_set_neon_superuser) {
        await transaction`RESET ROLE`;
      }
      operationStage = "owner-showcase-schema-ddl";
      await transaction.file(schemaPath);
    });
  } finally {
    await owner.end({ timeout: 5 });
  }
}

async function expectPermissionDenied(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "42501") {
      return true;
    }
    throw error;
  }
}

async function verifyPublisher(publisherUrl: string): Promise<{
  readonly capabilities: Omit<
    PermissionVerification,
    | "websiteCanReadCurrentCatalog"
    | "websiteCannotReadBaseTable"
    | "websiteCannotPublish"
    | "websiteRoleIsUnprivileged"
    | "websiteConnectionLimitIsBounded"
  >;
}> {
  const publisher = databaseClient(publisherUrl);
  try {
    const [permissions] = await publisher<
      {
        can_read_view: boolean;
        can_execute_publish: boolean;
        can_insert_base: boolean;
        can_create_schema: boolean;
        unprivileged: boolean;
        connection_limit: number;
      }[]
    >`
      SELECT
        has_table_privilege(current_user, 'showcase.current_catalog', 'SELECT') AS can_read_view,
        has_function_privilege(
          current_user,
          'showcase.publish_catalog(text,timestamptz,text,jsonb)',
          'EXECUTE'
        ) AS can_execute_publish,
        has_table_privilege(current_user, 'showcase.catalog_snapshots', 'INSERT') AS can_insert_base,
        has_schema_privilege(current_user, 'showcase', 'CREATE') AS can_create_schema,
        NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS unprivileged,
        rolconnlimit AS connection_limit
      FROM pg_roles
      WHERE rolname = current_user
    `;
    if (permissions === undefined) {
      throw new SafeBootstrapError("The Showcase publisher role could not be verified.");
    }

    const reserved = await publisher.reserve();
    let rollbackPublishProbePassed = false;
    let publisherCannotWriteBaseTable = false;
    try {
      await reserved`BEGIN`;
      const generatedAt = new Date("2026-01-01T00:00:00.000Z");
      const probeCatalog = {
        contractVersion: "showcase-public-v2",
        generatedAt: generatedAt.toISOString(),
        genres: [],
        artists: [],
        releases: [],
      };
      const [published] = await reserved<{ catalog_version: bigint }[]>`
        SELECT showcase.publish_catalog(
          ${probeCatalog.contractVersion},
          ${generatedAt},
          ${"0".repeat(64)},
          ${publisher.json(probeCatalog)}
        ) AS catalog_version
      `;
      rollbackPublishProbePassed = published !== undefined;
      publisherCannotWriteBaseTable = await expectPermissionDenied(
        async () =>
          await reserved`
            INSERT INTO showcase.catalog_snapshots (
              contract_version,
              generated_at,
              content_sha256,
              catalog
            ) VALUES (
              ${probeCatalog.contractVersion},
              ${generatedAt},
              ${"1".repeat(64)},
              ${publisher.json(probeCatalog)}
            )
          `,
      );
    } finally {
      await reserved`ROLLBACK`;
      reserved.release();
    }

    return {
      capabilities: {
        publisherCanReadCurrentCatalog: permissions.can_read_view,
        publisherCanPublishThroughFunction: permissions.can_execute_publish,
        publisherCannotWriteBaseTable:
          !permissions.can_insert_base && publisherCannotWriteBaseTable,
        publisherCannotCreateInShowcaseSchema: !permissions.can_create_schema,
        publisherRoleIsUnprivileged: permissions.unprivileged,
        publisherConnectionLimitIsBounded: permissions.connection_limit === 3,
        rollbackPublishProbePassed,
      },
    };
  } finally {
    await publisher.end({ timeout: 5 });
  }
}

async function verifyWebsite(websiteUrl: string): Promise<{
  readonly capabilities: Pick<
    PermissionVerification,
    | "websiteCanReadCurrentCatalog"
    | "websiteCannotReadBaseTable"
    | "websiteCannotPublish"
    | "websiteRoleIsUnprivileged"
    | "websiteConnectionLimitIsBounded"
  >;
}> {
  const website = databaseClient(websiteUrl);
  try {
    const [permissions] = await website<
      {
        can_read_view: boolean;
        can_read_base: boolean;
        can_publish: boolean;
        unprivileged: boolean;
        connection_limit: number;
      }[]
    >`
      SELECT
        has_table_privilege(current_user, 'showcase.current_catalog', 'SELECT') AS can_read_view,
        has_table_privilege(current_user, 'showcase.catalog_snapshots', 'SELECT') AS can_read_base,
        has_function_privilege(
          current_user,
          'showcase.publish_catalog(text,timestamptz,text,jsonb)',
          'EXECUTE'
        ) AS can_publish,
        NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS unprivileged,
        rolconnlimit AS connection_limit
      FROM pg_roles
      WHERE rolname = current_user
    `;
    if (permissions === undefined) {
      throw new SafeBootstrapError("The Showcase website role could not be verified.");
    }
    await website`SELECT catalog_version FROM showcase.current_catalog`;
    const websiteCannotReadBaseTable = await expectPermissionDenied(
      async () => await website`SELECT catalog_version FROM showcase.catalog_snapshots LIMIT 1`,
    );
    return {
      capabilities: {
        websiteCanReadCurrentCatalog: permissions.can_read_view,
        websiteCannotReadBaseTable: !permissions.can_read_base && websiteCannotReadBaseTable,
        websiteCannotPublish: !permissions.can_publish,
        websiteRoleIsUnprivileged: permissions.unprivileged,
        websiteConnectionLimitIsBounded: permissions.connection_limit === 20,
      },
    };
  } finally {
    await website.end({ timeout: 5 });
  }
}

async function verifyConnections(
  connections: RoleConnectionStrings,
): Promise<PermissionVerification> {
  const [publisher, website] = await Promise.all([
    verifyPublisher(connections.publisher),
    verifyWebsite(connections.website),
  ]);
  const verification = { ...publisher.capabilities, ...website.capabilities };
  if (Object.values(verification).some((value) => value !== true)) {
    throw new SafeBootstrapError("Showcase least-privilege verification failed.");
  }
  return verification;
}

function envFile(variableName: string, value: string): string {
  return `${variableName}="${value}"\n`;
}

async function secureWindowsFile(path: string): Promise<void> {
  if (process.platform !== "win32") {
    throw new SafeBootstrapError("Showcase credential ACL setup currently requires Windows.");
  }
  const { stdout } = await execFileAsync("whoami.exe", [], { windowsHide: true });
  const identity = stdout.trim();
  if (identity === "") throw new SafeBootstrapError("The current Windows identity is unavailable.");
  await execFileAsync(
    "icacls.exe",
    [path, "/inheritance:r", "/grant:r", `${identity}:(F)`, "*S-1-5-18:(F)"],
    { windowsHide: true },
  );
}

async function writeCredentialFiles(
  paths: LocalCredentialPaths,
  connections: RoleConnectionStrings,
  rotate: boolean,
): Promise<void> {
  await mkdir(dirname(paths.publisher), { recursive: true });
  const temporaryPublisher = `${paths.publisher}.${process.pid}.tmp`;
  const temporaryWebsite = `${paths.website}.${process.pid}.tmp`;
  try {
    await Promise.all([
      writeFile(
        temporaryPublisher,
        envFile("SHOWCASE_NEON_PUBLISHER_DATABASE_URL", connections.publisher),
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      ),
      writeFile(
        temporaryWebsite,
        envFile("SHOWCASE_NEON_PUBLIC_DATABASE_URL", connections.website),
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      ),
    ]);
    await Promise.all([secureWindowsFile(temporaryPublisher), secureWindowsFile(temporaryWebsite)]);
    if (rotate) {
      await Promise.all([rm(paths.publisher, { force: true }), rm(paths.website, { force: true })]);
    }
    await Promise.all([
      rename(temporaryPublisher, paths.publisher),
      rename(temporaryWebsite, paths.website),
    ]);
  } finally {
    await Promise.all([
      rm(temporaryPublisher, { force: true }),
      rm(temporaryWebsite, { force: true }),
    ]);
  }
}

async function readGeneratedConnections(
  paths: LocalCredentialPaths,
): Promise<RoleConnectionStrings> {
  const [publisherSource, websiteSource] = await Promise.all([
    readFile(paths.publisher, "utf8"),
    readFile(paths.website, "utf8"),
  ]);
  return {
    publisher: readEnvValue(publisherSource, "SHOWCASE_NEON_PUBLISHER_DATABASE_URL"),
    website: readEnvValue(websiteSource, "SHOWCASE_NEON_PUBLIC_DATABASE_URL"),
  };
}

async function main(): Promise<void> {
  operationStage = "local-credential-paths";
  const paths = localCredentialPaths();
  const verifyOnly = process.argv.includes("--verify-only");
  if (verifyOnly) {
    operationStage = "application-role-verification";
    const verification = await verifyConnections(await readGeneratedConnections(paths));
    console.log(
      JSON.stringify({
        event: "showcase.neon.verify.complete",
        verification,
      }),
    );
    return;
  }

  const rotate = process.argv.includes("--rotate");
  if (!rotate) {
    const filesExist = await Promise.all(
      [paths.publisher, paths.website].map(async (path) => {
        try {
          await readFile(path, "utf8");
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      }),
    );
    if (filesExist.some(Boolean)) {
      throw new SafeBootstrapError(
        "Showcase generated credential files already exist. Use --rotate only for an intentional rotation.",
      );
    }
  }

  operationStage = "owner-credential-read";
  const ownerSource = await readFile(paths.owner, "utf8");
  const ownerUrl = readEnvValue(ownerSource, "SHOWCASE_NEON_OWNER_DATABASE_URL");
  validateOwnerUrl(ownerUrl);
  const publisherPassword = randomPassword();
  const websitePassword = randomPassword();
  const connections = deriveRoleConnectionStrings(ownerUrl, publisherPassword, websitePassword);

  operationStage = "owner-bootstrap";
  await applyBootstrap(ownerUrl, publisherPassword, websitePassword, rotate);
  operationStage = "application-role-verification";
  const verification = await verifyConnections(connections);
  operationStage = "local-credential-write";
  await writeCredentialFiles(paths, connections, rotate);

  console.log(
    JSON.stringify({
      event: "showcase.neon.bootstrap.complete",
      schema: "showcase",
      roles: [publisherRole, websiteRole],
      publisherCredentialPath: paths.publisher,
      websiteCredentialPath: paths.website,
      verification,
    }),
  );
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  void main().catch((error: unknown) => {
    const message =
      error instanceof SafeBootstrapError
        ? error.message
        : "Showcase Neon bootstrap failed without exposing connection details.";
    const databaseCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[0-9A-Z]{5}$/u.test(error.code)
        ? error.code
        : undefined;
    console.error(
      JSON.stringify({
        event: "showcase.neon.bootstrap.failed",
        stage: operationStage,
        ...(databaseCode === undefined ? {} : { databaseCode }),
        message,
      }),
    );
    process.exitCode = 1;
  });
}
