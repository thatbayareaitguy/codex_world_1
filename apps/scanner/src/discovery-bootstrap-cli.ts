import {
  activateDiscoverySpotifyPriorityScheduler,
  createDatabase,
  getDiscoveryScheduleStatus,
  transitionAppleFirstCampaignToRecurringSchedule,
} from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadLocalEnvironment } from "./local-env";

loadLocalEnvironment();

interface DiscoveryBootstrapOptions {
  campaignId?: string;
  command: "activate" | "status" | "transition";
}

export function parseDiscoveryBootstrapOptions(args: string[]): DiscoveryBootstrapOptions {
  const values = args.filter((value) => value !== "--");
  const command = values.shift();
  if (command !== "activate" && command !== "status" && command !== "transition") {
    throw new Error(
      "Usage: pnpm discovery:bootstrap status | transition --campaign <campaign-id> | activate --campaign <campaign-id>",
    );
  }
  let campaignId: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === "--campaign") {
      campaignId = requiredValue(values[index + 1], "--campaign");
      index += 1;
      continue;
    }
    throw new Error(`Unknown discovery bootstrap option: ${value}`);
  }
  if ((command === "transition" || command === "activate") && !campaignId) {
    throw new Error(`${command} requires --campaign <campaign-id>.`);
  }
  return { command, ...(campaignId ? { campaignId } : {}) };
}

async function main(): Promise<void> {
  const options = parseDiscoveryBootstrapOptions(process.argv.slice(2));
  const configuration = loadProviderConfiguration();
  if (!configuration.databaseUrl) throw new Error("DATABASE_URL is required.");
  const connection = createDatabase(configuration.databaseUrl);
  try {
    const result =
      options.command === "transition"
        ? await transitionAppleFirstCampaignToRecurringSchedule(connection.db, options.campaignId!)
        : options.command === "activate"
          ? await activateDiscoverySpotifyPriorityScheduler(
              connection.db,
              options.campaignId!,
            ).then(() => getDiscoveryScheduleStatus(connection.db))
          : await getDiscoveryScheduleStatus(connection.db);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await connection.client.end();
  }
}

function requiredValue(value: string | undefined, option: string): string {
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

if (
  process.env.VITEST !== "true" &&
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Bootstrap failed."}\n`);
    process.exitCode = 1;
  });
}
