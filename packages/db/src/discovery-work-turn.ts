import { and, eq } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import { providerCache } from "./schema";

export async function getDiscoveryWorkTurn(
  db: RadarDatabase,
): Promise<"delivery" | "matching" | null> {
  const row = await db.query.providerCache.findFirst({
    where: and(
      eq(providerCache.provider, "spotify"),
      eq(providerCache.cacheKey, "discovery-work-turn"),
    ),
  });
  const value = row?.value;
  return value === "delivery" || value === "matching" ? value : null;
}

export async function recordDiscoveryWorkTurn(db: RadarDatabase, value: "delivery" | "matching") {
  const now = new Date();
  await db
    .insert(providerCache)
    .values({
      provider: "spotify",
      cacheKey: "discovery-work-turn",
      value,
      expiresAt: new Date(now.getTime() + 30 * 86_400_000),
    })
    .onConflictDoUpdate({
      target: [providerCache.provider, providerCache.cacheKey],
      set: { value, updatedAt: now, expiresAt: new Date(now.getTime() + 30 * 86_400_000) },
    });
}
