import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const feedSorts = ["release", "first-seen"] as const;

export interface FeedQueryFilters {
  artist?: string;
  dateFrom?: string;
  dateTo?: string;
  exactOnly?: boolean;
  provider?: "mock" | "musicbrainz" | "reddit" | "spotify";
  releaseType?: string;
  search?: string;
  sort: (typeof feedSorts)[number];
  spotify?: "available" | "unavailable";
  state?: "new" | "upcoming" | "saved" | "dismissed" | "listened" | "needs_review";
}

export interface FeedCursorPosition {
  firstSeenAt: string;
  releaseDate: string;
  releasePrecision: number;
  stableId: string;
}

const cursorPayloadSchema = z.object({
  filterHash: z.string().length(64),
  firstSeenAt: z.iso.datetime(),
  releaseDate: z.iso.date(),
  releasePrecision: z.number().int().min(1).max(3),
  sort: z.enum(feedSorts),
  stableId: z.uuid(),
  version: z.literal(1),
});

export function createFeedCursor(
  position: FeedCursorPosition,
  filters: FeedQueryFilters,
  secret: string,
): string {
  const payload = JSON.stringify({
    ...position,
    filterHash: feedFilterHash(filters),
    sort: filters.sort,
    version: 1,
  });
  const encodedPayload = Buffer.from(payload).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
}

export function parseFeedCursor(
  token: string,
  filters: FeedQueryFilters,
  secret: string,
): FeedCursorPosition {
  const [encodedPayload, providedSignature, extra] = token.split(".");
  if (!encodedPayload || !providedSignature || extra) throw new Error("Feed cursor is malformed");
  const expectedSignature = sign(encodedPayload, secret);
  const expected = Buffer.from(expectedSignature);
  const provided = Buffer.from(providedSignature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new Error("Feed cursor signature is invalid");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw new Error("Feed cursor payload is invalid");
  }
  const payload = cursorPayloadSchema.parse(decoded);
  if (payload.sort !== filters.sort || payload.filterHash !== feedFilterHash(filters)) {
    throw new Error("Feed cursor does not match the current query");
  }
  return {
    firstSeenAt: payload.firstSeenAt,
    releaseDate: payload.releaseDate,
    releasePrecision: payload.releasePrecision,
    stableId: payload.stableId,
  };
}

export function feedFilterHash(filters: FeedQueryFilters): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeFilters(filters)))
    .digest("hex");
}

function normalizeFilters(filters: FeedQueryFilters): Record<string, boolean | string> {
  return Object.fromEntries(
    Object.entries(filters)
      .filter((entry): entry is [string, boolean | string] => entry[1] !== undefined)
      .map(([key, value]): [string, boolean | string] => [
        key,
        typeof value === "string" ? value.trim() : value,
      ])
      .sort((left, right) => left[0].localeCompare(right[0])),
  );
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
