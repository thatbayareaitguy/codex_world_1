import {
  appleMusicLiveConfirmation,
  type AppleMusicPilotPlan,
} from "./apple-music-pilot-definition";
import {
  authorizeAppleMusicPilotLive,
  type AppleMusicPilotLiveAuthorization,
  type AppleMusicPilotRunSummary,
} from "./apple-music-pilot-runner";

export type AppleMusicPilotCommand =
  | { mode: "plan"; snapshotPath: string }
  | {
      confirmation: string;
      mode: "execute_live";
      snapshotPath: string;
      stopAfterCanary: boolean;
    };

export interface AppleMusicPilotCommandDependencies {
  createPlan(snapshotPath: string): Promise<AppleMusicPilotPlan>;
  executeLive(
    authorization: AppleMusicPilotLiveAuthorization,
    snapshotPath: string,
  ): Promise<AppleMusicPilotRunSummary>;
  loadLiveSafety(): Promise<{
    otherProvidersDisabled: boolean;
    persistentAppleMusicEnabled: string | undefined;
    storefront: string;
  }>;
}

export async function executeAppleMusicPilotCommand(
  args: string[],
  dependencies: AppleMusicPilotCommandDependencies,
): Promise<
  | { mode: "plan"; plan: AppleMusicPilotPlan }
  | { mode: "execute_live"; summary: AppleMusicPilotRunSummary }
> {
  const command = parseAppleMusicPilotCommand(args);
  if (command.mode === "plan") {
    return { mode: "plan", plan: await dependencies.createPlan(command.snapshotPath) };
  }
  const safety = await dependencies.loadLiveSafety();
  const authorization = authorizeAppleMusicPilotLive({
    confirmation: command.confirmation,
    executeLive: true,
    stopAfterCanary: command.stopAfterCanary,
    ...safety,
  });
  return {
    mode: "execute_live",
    summary: await dependencies.executeLive(authorization, command.snapshotPath),
  };
}

export function parseAppleMusicPilotCommand(args: string[]): AppleMusicPilotCommand {
  const values = args.filter((value) => value !== "--");
  const plan = values.includes("--plan");
  const executeLive = values.includes("--execute-live");
  if (plan === executeLive) {
    throw new Error("Choose exactly one of --plan or --execute-live.");
  }
  const snapshotPath = requiredOption(values, "--snapshot");
  const confirmation = optionalOption(values, "--confirm-live");
  const stopAfterCanary = values.includes("--stop-after-canary");
  const allowed = new Set([
    "--plan",
    "--execute-live",
    "--snapshot",
    "--confirm-live",
    "--stop-after-canary",
    snapshotPath,
    ...(confirmation ? [confirmation] : []),
  ]);
  const unexpected = values.filter((value) => !allowed.has(value));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected Apple pilot argument: ${unexpected[0]}`);
  }
  if (plan) {
    if (confirmation !== undefined) {
      throw new Error("Plan mode does not accept --confirm-live.");
    }
    if (stopAfterCanary) {
      throw new Error("Plan mode does not accept --stop-after-canary.");
    }
    return { mode: "plan", snapshotPath };
  }
  if (confirmation !== appleMusicLiveConfirmation) {
    throw new Error(`Live Apple execution requires --confirm-live ${appleMusicLiveConfirmation}.`);
  }
  return { confirmation, mode: "execute_live", snapshotPath, stopAfterCanary };
}

function requiredOption(args: string[], name: string): string {
  const value = optionalOption(args, name);
  if (!value || value.startsWith("--")) throw new Error(`${name} is required.`);
  return value;
}

function optionalOption(args: string[], name: string): string | undefined {
  const positions = args.flatMap((value, index) => (value === name ? [index] : []));
  if (positions.length > 1) throw new Error(`${name} may be provided only once.`);
  const index = positions[0];
  return index === undefined ? undefined : args[index + 1];
}
