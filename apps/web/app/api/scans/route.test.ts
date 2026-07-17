import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { end, findFirst, launchScanNow } = vi.hoisted(() => ({
  end: vi.fn(() => Promise.resolve()),
  findFirst: vi.fn(),
  launchScanNow: vi.fn(() => Promise.resolve({ pid: 4242 })),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(() => "where"),
  desc: vi.fn(() => "order"),
  eq: vi.fn(() => "eq"),
  gt: vi.fn(() => "gt"),
}));
vi.mock("@radar/db", () => ({
  createDatabase: vi.fn(() => ({
    client: { end },
    db: { query: { operationLocks: { findFirst } } },
  })),
  operationLocks: { expiresAt: "expiresAt", lockKey: "lockKey" },
  scanRuns: { startedAt: "startedAt" },
}));
vi.mock("@radar/providers", () => ({
  loadProviderConfiguration: vi.fn(() => ({ databaseUrl: "postgres://synthetic" })),
}));
vi.mock("../../../lib/request-security", () => ({
  assertSameOrigin: vi.fn(),
  enforceRateLimit: vi.fn(),
}));
vi.mock("../../../lib/scan-launcher", () => ({ launchScanNow }));

import { POST } from "./route";

const request = () =>
  new NextRequest("http://127.0.0.1:3000/api/scans", {
    headers: { origin: "http://127.0.0.1:3000" },
    method: "POST",
  });

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue(undefined);
});

describe("on-demand scan route", () => {
  it("launches one background scan", async () => {
    const response = await POST(request());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(launchScanNow).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it("rejects a duplicate launch while the global scan lock is active", async () => {
    findFirst.mockResolvedValue({ lockKey: "scan:global" });

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "A scan is already running" });
    expect(launchScanNow).not.toHaveBeenCalled();
  });
});
