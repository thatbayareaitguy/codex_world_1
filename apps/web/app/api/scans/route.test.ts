import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { end, findFirst, launchScanNow, requestOperationCancellation } = vi.hoisted(() => ({
  end: vi.fn(() => Promise.resolve()),
  findFirst: vi.fn(),
  launchScanNow: vi.fn(() => Promise.resolve({ pid: 4242 })),
  requestOperationCancellation: vi.fn(() => Promise.resolve(true)),
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
  requestOperationCancellation,
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

import { DELETE, describeActiveScan, POST } from "./route";

const request = (method = "POST") =>
  new NextRequest("http://127.0.0.1:3000/api/scans", {
    headers: { origin: "http://127.0.0.1:3000" },
    method,
  });

const jsonRequest = (body: unknown) =>
  new NextRequest("http://127.0.0.1:3000/api/scans", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
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

  it("launches an isolated one-artist MusicBrainz scan", async () => {
    const artistId = "11111111-1111-4111-8111-111111111111";
    const response = await POST(jsonRequest({ artistId, provider: "musicbrainz" }));

    expect(response.status).toBe(202);
    expect(launchScanNow).toHaveBeenCalledWith(undefined, undefined, undefined, [
      "--provider",
      "musicbrainz",
      "--artist",
      artistId,
    ]);
  });

  it("reports provider-stage progress from the active lock and completed runs", () => {
    const startedAt = new Date("2026-07-17T17:23:31.517Z");
    const progress = describeActiveScan(
      {
        acquiredAt: startedAt,
        expiresAt: new Date("2026-07-17T19:23:31.517Z"),
        metadata: { provider: "all" },
      },
      [
        {
          provider: "spotify",
          providersCompleted: ["spotify"],
          providersFailed: [],
          startedAt: new Date("2026-07-17T17:24:00.000Z"),
          status: "completed",
        },
        {
          provider: "mock",
          providersCompleted: ["mock"],
          providersFailed: [],
          startedAt: new Date("2026-07-17T17:20:00.000Z"),
          status: "completed",
        },
      ],
      ["spotify", "musicbrainz"],
    );

    expect(progress).toEqual({
      cancelRequested: false,
      completedUnits: 0,
      currentProvider: "musicbrainz",
      currentStage: null,
      currentUnit: null,
      expiresAt: new Date("2026-07-17T19:23:31.517Z"),
      heartbeatAt: null,
      lastPersistedResult: null,
      phase: null,
      providersCompleted: ["spotify"],
      providersFailed: [],
      providersRequested: ["spotify", "musicbrainz"],
      rateLimitWaitMs: 0,
      requests: 0,
      retryAfterMs: 0,
      startedAt,
      totalUnits: 0,
    });
  });

  it("requests cooperative cancellation for the active scan", async () => {
    const response = await DELETE(request("DELETE"));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(requestOperationCancellation).toHaveBeenCalledWith(expect.anything(), "scan:global");
  });

  it("rejects a duplicate launch while the global scan lock is active", async () => {
    findFirst.mockResolvedValue({ lockKey: "scan:global" });

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "A scan is already running" });
    expect(launchScanNow).not.toHaveBeenCalled();
  });
});
