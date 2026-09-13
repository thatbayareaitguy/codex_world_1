import { log } from "@radar/core";
import {
  ensureLocalOwner,
  listRedditSources,
  persistRedditListing,
  purgeDeletedRedditSubmissions,
  redditSources,
  redditSubmissions,
  scanRuns,
  type RadarDatabase,
} from "@radar/db";
import { assertRedditAccessGate, RedditClient, type ProviderConfiguration } from "@radar/providers";
import { eq, inArray } from "drizzle-orm";
import type { ScannerOptions } from "./args";

export interface RedditScanSummary {
  discovered: number;
  dryRun: boolean;
  inserted: number;
  needsReview: number;
  skipped: number;
}

export async function runRedditScan(
  db: RadarDatabase,
  configuration: ProviderConfiguration,
  options: ScannerOptions,
  dependencies: { client?: RedditClient; now?: () => Date } = {},
): Promise<RedditScanSummary> {
  assertRedditAccessGate(configuration.reddit);
  const client = dependencies.client ?? new RedditClient(configuration.reddit);
  const now = dependencies.now?.() ?? new Date();
  const userId = await ensureLocalOwner(db);
  const allSources = await listRedditSources(db, userId);
  const sources = options.source
    ? allSources.filter(
        (source) =>
          source.subreddit.toLocaleLowerCase("en-US") ===
          options.source?.toLocaleLowerCase("en-US"),
      )
    : allSources.filter((source) => source.enabled);
  if (sources.length === 0) {
    throw new Error(
      options.source
        ? `Reddit source r/${options.source} is not configured.`
        : "No enabled Reddit sources are configured.",
    );
  }

  const [run] = await db
    .insert(scanRuns)
    .values({
      dryRun: options.dryRun,
      detailedExpiresAt: new Date(
        now.getTime() + configuration.scanDetailRetentionDays * 86_400_000,
      ),
      provider: "reddit",
      providersRequested: ["reddit"],
      triggerType: options.full ? "full_reconciliation" : "provider_manual",
    })
    .returning({ id: scanRuns.id });
  if (!run) throw new Error("Failed to create Reddit scan run.");

  const summary: RedditScanSummary = {
    discovered: 0,
    dryRun: options.dryRun,
    inserted: 0,
    needsReview: 0,
    skipped: 0,
  };
  const failures: Array<{ message: string; source: string }> = [];
  try {
    for (const source of sources) {
      try {
        let after: string | undefined;
        const horizon = new Date(
          options.since
            ? Date.parse(options.since)
            : now.getTime() - source.initialBackfillDays * 86_400_000,
        );
        for (let page = 0; page < source.maxPagesPerScan; page += 1) {
          const listing = await client.listNew({
            ...(after ? { after } : {}),
            limit: 100,
            subreddit: source.subreddit,
          });
          const inHorizon = listing.data.children.filter(
            (child) => child.data.created_utc * 1_000 >= horizon.getTime(),
          );
          summary.discovered += inHorizon.length;
          if (options.dryRun) {
            summary.skipped += inHorizon.length;
          } else {
            const persisted = await persistRedditListing(
              db,
              userId,
              source.id,
              { ...listing, data: { ...listing.data, children: inHorizon } },
              now,
            );
            summary.inserted += persisted.insertedCandidates;
            summary.needsReview += persisted.needsReview;
            summary.skipped += persisted.duplicates;
          }
          const oldest = listing.data.children.at(-1)?.data.created_utc;
          const reachedKnownPost = listing.data.children.some(
            (child) =>
              child.data.name === source.lastSeenFullname &&
              child.data.created_utc * 1_000 <
                now.getTime() - source.scanOverlapHours * 60 * 60_000,
          );
          if (
            reachedKnownPost ||
            oldest === undefined ||
            oldest * 1_000 < horizon.getTime() ||
            !listing.data.after
          ) {
            break;
          }
          after = listing.data.after;
        }
      } catch (error) {
        const message = safeScanError(error);
        failures.push({ message, source: source.subreddit });
        await db
          .update(redditSources)
          .set({ lastError: message, updatedAt: now })
          .where(eq(redditSources.id, source.id));
        log("error", "reddit.source_scan_failed", { message, source: source.subreddit });
      }
    }

    const metrics = client.metrics();
    await db
      .update(scanRuns)
      .set({
        completedAt: new Date(),
        discoveredCount: summary.discovered,
        duplicatesIgnoredCount: summary.skipped,
        errors: failures,
        insertedCount: summary.inserted,
        metadata: { rateLimit: metrics, sources: sources.map((source) => source.subreddit) },
        providersCompleted: failures.length < sources.length ? ["reddit"] : [],
        providersFailed: failures.length > 0 ? ["reddit"] : [],
        reviewCount: summary.needsReview,
        skippedCount: summary.skipped,
        status:
          failures.length === 0
            ? "completed"
            : failures.length === sources.length
              ? "failed"
              : "partial",
      })
      .where(eq(scanRuns.id, run.id));
    if (failures.length === sources.length) {
      throw new Error(failures.map((failure) => failure.message).join("; "));
    }
    return summary;
  } catch (error) {
    await db
      .update(scanRuns)
      .set({
        completedAt: new Date(),
        errors: [{ message: safeScanError(error) }],
        providersFailed: ["reddit"],
        status: "failed",
      })
      .where(eq(scanRuns.id, run.id));
    throw error;
  }
}

export async function reconcileRedditDeletions(
  db: RadarDatabase,
  configuration: ProviderConfiguration,
  dependencies: { client?: RedditClient; now?: () => Date } = {},
) {
  assertRedditAccessGate(configuration.reddit);
  const client = dependencies.client ?? new RedditClient(configuration.reddit);
  const now = dependencies.now?.() ?? new Date();
  const retained = await db
    .select({ fullname: redditSubmissions.fullname })
    .from(redditSubmissions)
    .where(eq(redditSubmissions.sourceState, "active"));
  let checked = 0;
  let deleted = 0;
  let preservedCanonical = 0;
  for (let index = 0; index < retained.length; index += 100) {
    const batch = retained.slice(index, index + 100).map((row) => row.fullname);
    const listing = await client.info(batch);
    const returned = new Set(listing.data.children.map((child) => child.data.name));
    const missing = batch.filter((fullname) => !returned.has(fullname));
    const result = await purgeDeletedRedditSubmissions(db, missing, now);
    checked += batch.length;
    deleted += result.deleted;
    preservedCanonical += result.preservedCanonical;
    if (listing.data.children.length > 0) {
      await db
        .update(redditSubmissions)
        .set({ lastCheckedAt: now, updatedAt: now })
        .where(
          inArray(
            redditSubmissions.fullname,
            listing.data.children.map((child) => child.data.name),
          ),
        );
    }
  }
  return { checked, deleted, preservedCanonical };
}

function safeScanError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown Reddit scan error";
  return message.replace(/(?:Bearer|Basic)\s+\S+/gi, "[REDACTED]").slice(0, 1_000);
}
