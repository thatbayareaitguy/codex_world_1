import { randomUUID } from "node:crypto";
import {
  artistExternalIds,
  artistFollows,
  artists,
  createDatabase,
  createOrResumeDiscoveryReconciliationCampaign,
  users,
} from "@radar/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runAppleFirstSync } from "./apple-first-sync-cli";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

describe.sequential("Apple-first synchronization CLI status", () => {
  const connection = createDatabase(databaseUrl);
  const userId = randomUUID();
  const artistId = randomUUID();

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", databaseUrl);
    await connection.db.execute(sql`truncate table users, artists restart identity cascade`);
    await connection.db.insert(users).values({
      id: userId,
      displayName: "Apple-first status owner",
      email: "apple-first-status@example.invalid",
    });
    await connection.db.insert(artists).values({
      id: artistId,
      name: "Status Artist",
      normalizedName: "status artist",
    });
    await connection.db.insert(artistFollows).values({ active: true, artistId, userId });
    await connection.db.insert(artistExternalIds).values({
      artistId,
      confirmed: true,
      externalId: "1234567890",
      provider: "apple_music",
    });
    await connection.db.insert(artistExternalIds).values({
      artistId,
      confirmed: true,
      externalId: "spotify-status-artist",
      provider: "spotify",
    });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await connection.client.end();
  });

  it("awaits the persisted report before closing its database connection", async () => {
    const campaign = await createOrResumeDiscoveryReconciliationCampaign(
      connection.db,
      {
        spotifyCohortSize: 1,
        spotifyPageLimit: 1,
        spotifyRotationSize: 0,
        windowDays: 60,
      },
      new Date("2026-08-07T12:00:00.000Z"),
    );

    await expect(
      runAppleFirstSync({
        campaignId: campaign.campaignId,
        confirmLiveProviders: false,
        mode: "status",
      }),
    ).resolves.toMatchObject({
      campaign: { id: campaign.campaignId, totalArtists: 1 },
    });
  });
});
