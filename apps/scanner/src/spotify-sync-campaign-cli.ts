import {
  advanceSpotifySyncCampaignCanary,
  cancelSpotifySyncCampaign,
  createDatabase,
  createSpotifySyncCampaign,
  getSpotifySyncCampaignStatus,
  listSpotifySyncCampaignMembers,
  listSpotifySyncCampaignWork,
  pauseSpotifySyncCampaign,
  resumeSpotifySyncCampaign,
  startSpotifySyncCampaign,
} from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { loadLocalEnvironment } from "./local-env";
import {
  createProductionSchedulerExecutor,
  schedulerLimitsFromConfiguration,
} from "./spotify-scheduler-cli";
import { runSpotifySyncCampaignTick } from "./spotify-sync-campaign";

loadLocalEnvironment();

type CampaignCommand =
  | "create"
  | "plan"
  | "start"
  | "resume"
  | "pause"
  | "cancel"
  | "tick"
  | "status"
  | "members"
  | "work"
  | "canary-pass"
  | "canary-fail";

interface CampaignOptions {
  campaignId?: string;
  canary: number;
  command: CampaignCommand;
  deadlineHours: number;
  target: number;
}

export function parseSpotifySyncCampaignOptions(args: string[]): CampaignOptions {
  const values = args.filter((value) => value !== "--");
  const command = values[0] as CampaignCommand | undefined;
  const commands: CampaignCommand[] = [
    "create",
    "plan",
    "start",
    "resume",
    "pause",
    "cancel",
    "tick",
    "status",
    "members",
    "work",
    "canary-pass",
    "canary-fail",
  ];
  if (!command || !commands.includes(command)) throw new Error(usage());
  const options: CampaignOptions = {
    canary: integerOption(values, "--canary", 10),
    command,
    deadlineHours: integerOption(values, "--deadline-hours", 8),
    target: integerOption(values, "--target", 100),
  };
  const campaignId = stringOption(values, "--campaign");
  if (campaignId) options.campaignId = campaignId;
  if (command !== "create" && !campaignId) throw new Error(`${command} requires --campaign <id>.`);
  return options;
}

async function main(): Promise<void> {
  const options = parseSpotifySyncCampaignOptions(process.argv.slice(2));
  const configuration = loadProviderConfiguration();
  if (!configuration.databaseUrl) throw new Error("DATABASE_URL is required.");
  if (configuration.spotify.playlistWritesEnabled) {
    throw new Error("Spotify playlist writes must remain disabled for campaign execution.");
  }
  const connection = createDatabase(configuration.databaseUrl);
  try {
    if (options.command === "create") {
      const now = new Date();
      const campaign = await createSpotifySyncCampaign(connection.db, {
        canaryTarget: options.canary,
        expiresAt: new Date(now.getTime() + options.deadlineHours * 60 * 60_000),
        now,
        targetSuccesses: options.target,
      });
      const members = await listSpotifySyncCampaignMembers(connection.db, campaign.id);
      output({
        baselineSize: campaign.baselineArtistCount,
        campaignId: campaign.id,
        canaryTarget: campaign.canaryTarget,
        expiresAt: campaign.expiresAt,
        firstMembers: members.slice(0, 10).map((member) => ({
          artistId: member.artistId,
          ordinal: member.ordinal,
        })),
        nextBaseClaimAt: campaign.nextBaseClaimAt,
        status: campaign.status,
        target: campaign.targetSuccesses,
      });
      return;
    }
    const campaignId = options.campaignId!;
    if (options.command === "status") {
      output(await requiredStatus(connection.db, campaignId));
      return;
    }
    if (options.command === "members") {
      const members = await listSpotifySyncCampaignMembers(connection.db, campaignId);
      output(
        members.map((member) => ({
          artistId: member.artistId,
          attemptCount: member.attemptCount,
          blockedReason: member.blockedReason,
          ordinal: member.ordinal,
          qualifiedAt: member.qualifiedAt,
          status: member.status,
        })),
      );
      return;
    }
    if (options.command === "work") {
      const work = await listSpotifySyncCampaignWork(connection.db, campaignId);
      output(
        work.map((item) => ({
          attemptCount: item.attemptCount,
          lastErrorClassification: item.lastErrorClassification,
          status: item.status,
          workId: abbreviate(item.id),
          workType: item.workType,
        })),
      );
      return;
    }
    if (options.command === "start") {
      output({ changed: await startSpotifySyncCampaign(connection.db, campaignId) });
      return;
    }
    if (options.command === "resume") {
      const now = new Date();
      output({
        changed: await resumeSpotifySyncCampaign(connection.db, campaignId, {
          expiresAt: new Date(now.getTime() + options.deadlineHours * 60 * 60_000),
          now,
        }),
      });
      return;
    }
    if (options.command === "pause") {
      output({
        changed: await pauseSpotifySyncCampaign(
          connection.db,
          campaignId,
          "operator_requested_pause",
        ),
      });
      return;
    }
    if (options.command === "cancel") {
      output({
        changed: await cancelSpotifySyncCampaign(
          connection.db,
          campaignId,
          "operator_cancelled_future_work",
        ),
      });
      return;
    }
    if (options.command === "canary-pass" || options.command === "canary-fail") {
      output({
        changed: await advanceSpotifySyncCampaignCanary(
          connection.db,
          campaignId,
          options.command === "canary-pass",
        ),
      });
      return;
    }
    const mode = options.command === "plan" ? "plan" : "production";
    const executor =
      mode === "production"
        ? await createProductionSchedulerExecutor(connection.db, configuration)
        : undefined;
    const result = await runSpotifySyncCampaignTick(connection.db, {
      campaignId,
      ...(executor ? { executor } : {}),
      limits: schedulerLimitsFromConfiguration(configuration),
      mode,
    });
    output({
      mode: result.mode,
      reason: result.reason,
      requestsStarted: result.requestsStarted,
      selected: result.selected
        ? {
            campaignMemberId: result.selected.campaignMemberId
              ? abbreviate(result.selected.campaignMemberId)
              : null,
            workId: abbreviate(result.selected.id),
            workType: result.selected.workType,
          }
        : null,
      status: result.status,
    });
  } finally {
    await connection.client.end();
  }
}

async function requiredStatus(db: ReturnType<typeof createDatabase>["db"], campaignId: string) {
  const status = await getSpotifySyncCampaignStatus(db, campaignId);
  if (!status) throw new Error("Spotify sync campaign does not exist.");
  return status;
}

function integerOption(values: string[], name: string, fallback: number): number {
  const value = stringOption(values, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive.`);
  return parsed;
}

function stringOption(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : undefined;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function abbreviate(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function usage(): string {
  return "Usage: spotify:campaign <create|plan|start|resume|pause|cancel|tick|status|members|work|canary-pass|canary-fail> [--campaign <id>]";
}

if (process.env.VITEST !== "true") {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Campaign command failed."}\n`,
    );
    process.exitCode = 1;
  });
}
