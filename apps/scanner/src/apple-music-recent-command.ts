import { validateAppleMusicPilotSnapshot } from "./apple-music-pilot-definition";
import {
  appleMusicRecentConfirmation,
  appleMusicRecentEvaluationTime,
  appleMusicRecentSample,
} from "./apple-music-recent";
import { readItunesPilotSnapshot, type ItunesPilotSnapshot } from "./itunes-pilot-snapshot";

export interface AppleMusicRecentPlan {
  artists: string[];
  evaluationAsOf: string;
  forecast: {
    armARequests: number;
    armBRequests: number;
    armCRequests: number;
    mappingRequests: number;
    requestBudget: 100;
    retryReserve: number;
    targetedDetailRequests: number;
    totalRequests: number;
  };
  limits: {
    concurrency: 1;
    maximumRuntimeMs: 900_000;
    minRequestIntervalMs: 1_100;
    requestBudget: 100;
  };
  mode: "plan";
  networkRequestsStarted: 0;
  noPagination: true;
  snapshotHash: string;
  storefront: "us";
  writes: 0;
}

export type AppleMusicRecentCommand =
  | { mode: "plan"; snapshotPath: string }
  | {
      confirmation: typeof appleMusicRecentConfirmation;
      evaluationAsOf: typeof appleMusicRecentEvaluationTime;
      mode: "execute_live";
      snapshotPath: string;
    };

export function parseAppleMusicRecentCommand(args: string[]): AppleMusicRecentCommand {
  const values = args.filter((value) => value !== "--");
  const plan = values.includes("--plan");
  const live = values.includes("--execute-live");
  if (plan === live) throw new Error("Choose exactly one of --plan or --execute-live.");
  if (!values.includes("--sample")) throw new Error("Apple recent MVP requires --sample.");
  const snapshotPath = requiredOption(values, "--snapshot");
  const confirmation = optionalOption(values, "--confirm-live");
  const evaluationAsOf = optionalOption(values, "--evaluation-as-of");
  const optionNames = new Set([
    "--plan",
    "--execute-live",
    "--sample",
    "--snapshot",
    "--confirm-live",
    "--evaluation-as-of",
  ]);
  const optionValues = new Set(
    [snapshotPath, confirmation, evaluationAsOf].filter((value): value is string => Boolean(value)),
  );
  const unexpected = values.find((value) => !optionNames.has(value) && !optionValues.has(value));
  if (unexpected) throw new Error(`Unexpected Apple recent argument: ${unexpected}`);
  if (plan) {
    if (confirmation || evaluationAsOf) {
      throw new Error("Plan mode does not accept live confirmation or evaluation time.");
    }
    return { mode: "plan", snapshotPath };
  }
  if (confirmation !== appleMusicRecentConfirmation) {
    throw new Error(`Live execution requires --confirm-live ${appleMusicRecentConfirmation}.`);
  }
  if (evaluationAsOf !== appleMusicRecentEvaluationTime) {
    throw new Error(`Live sample requires --evaluation-as-of ${appleMusicRecentEvaluationTime}.`);
  }
  return { confirmation, evaluationAsOf, mode: "execute_live", snapshotPath };
}

export async function createAppleMusicRecentPlan(
  snapshotPath: string,
  readSnapshot: (path: string) => Promise<ItunesPilotSnapshot> = readItunesPilotSnapshot,
): Promise<AppleMusicRecentPlan> {
  const snapshot = await readSnapshot(snapshotPath);
  const cohort = validateAppleMusicPilotSnapshot(snapshot);
  for (const name of appleMusicRecentSample) {
    if (!cohort.some((artist) => artist.name === name)) {
      throw new Error(`Recent sample artist ${name} is absent from the pinned cohort.`);
    }
  }
  const forecast = {
    armARequests: 20,
    armBRequests: 20,
    armCRequests: 20,
    mappingRequests: 13,
    requestBudget: 100 as const,
    retryReserve: 10,
    targetedDetailRequests: 10,
    totalRequests: 93,
  };
  return {
    artists: [...appleMusicRecentSample],
    evaluationAsOf: appleMusicRecentEvaluationTime,
    forecast,
    limits: {
      concurrency: 1,
      maximumRuntimeMs: 900_000,
      minRequestIntervalMs: 1_100,
      requestBudget: 100,
    },
    mode: "plan",
    networkRequestsStarted: 0,
    noPagination: true,
    snapshotHash: snapshot.snapshotHash,
    storefront: "us",
    writes: 0,
  };
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
