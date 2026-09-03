import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import postgres from "postgres";

import { readEnvValue, validateOwnerUrl } from "./showcase-neon-bootstrap";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(
  scriptDirectory,
  "..",
  "apps",
  "showcase",
  "neon",
  "0002_public_catalog_v3.sql",
);
let operationStage = "startup";

async function main(): Promise<void> {
  const localData = process.env.LOCALAPPDATA;
  if (localData === undefined || localData.trim() === "") {
    throw new Error("LOCALAPPDATA is required for the Showcase Neon schema migration.");
  }
  operationStage = "owner-credential-read";
  const ownerSource = await readFile(resolve(localData, "Showcase", "neon-owner.env"), "utf8");
  const ownerUrl = readEnvValue(ownerSource, "SHOWCASE_NEON_OWNER_DATABASE_URL");
  validateOwnerUrl(ownerUrl);

  const owner = postgres(ownerUrl, {
    connect_timeout: 15,
    idle_timeout: 5,
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  try {
    operationStage = "owner-schema-migration";
    await owner.begin(async (transaction) => {
      const [membership] = await transaction<{ can_set_schema_owner: boolean }[]>`
        SELECT pg_has_role(current_user, 'showcase_schema_owner', 'SET') AS can_set_schema_owner
      `;
      if (membership?.can_set_schema_owner !== true) {
        throw new Error("The Neon owner cannot assume the Showcase schema-owner role.");
      }
      await transaction`SET LOCAL ROLE showcase_schema_owner`;
      await transaction.file(migrationPath);
    });
  } finally {
    await owner.end({ timeout: 5 });
  }

  console.log(
    JSON.stringify({
      event: "showcase.neon.migration.complete",
      migration: "0002_public_catalog_v3",
    }),
  );
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  void main().catch((error: unknown) => {
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
        event: "showcase.neon.migration.failed",
        stage: operationStage,
        ...(databaseCode === undefined ? {} : { databaseCode }),
        message: "The Showcase Neon schema migration failed without exposing connection details.",
      }),
    );
    process.exitCode = 1;
  });
}
