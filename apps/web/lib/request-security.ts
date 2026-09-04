import { loadProviderConfiguration } from "@radar/providers";
import type { NextRequest } from "next/server";

const attempts = new Map<string, { count: number; resetAt: number }>();

export function assertSameOrigin(request: NextRequest): void {
  const origin = request.headers.get("origin");
  const expected = new URL(loadProviderConfiguration().appBaseUrl).origin;
  if (!origin || origin !== expected) throw new Error("Cross-origin request rejected");
}

export function enforceRateLimit(
  request: NextRequest,
  limit = 20,
  windowMs = 60_000,
  scope = new URL(request.url).pathname,
): void {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const client = forwarded ?? request.headers.get("user-agent") ?? "local";
  const key = `${scope}:${client}`;
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  current.count += 1;
  if (current.count > limit) throw new Error("Too many requests");
}
