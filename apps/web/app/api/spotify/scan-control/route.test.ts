import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { end, findLock, getOperational, launchScanNow, pause, resume } = vi.hoisted(() => ({
  end: vi.fn(() => Promise.resolve()),
  findLock: vi.fn(),
  getOperational: vi.fn(),
  launchScanNow: vi.fn(() => Promise.resolve({ pid: 1234 })),
  pause: vi.fn(() => Promise.resolve(true)),
  resume: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(() => "where"),
  eq: vi.fn(() => "eq"),
  gt: vi.fn(() => "gt"),
}));
vi.mock("@radar/db", () => ({
  cancelSpotifyBatch: vi.fn(() => Promise.resolve(true)),
  createDatabase: vi.fn(() => ({
    client: { end },
    db: {
      query: {
        operationLocks: { findFirst: findLock },
        spotifyArtistScans: { findFirst: vi.fn() },
      },
    },
  })),
  getSpotifyOperationalStatus: getOperational,
  operationLocks: { expiresAt: "expiresAt", lockKey: "lockKey" },
  requestSpotifyBatchPause: pause,
  resumeSpotifyBatch: resume,
  retrySpotifyArtist: vi.fn(),
  spotifyArtistScans: { id: "id" },
}));
vi.mock("@radar/providers", () => ({
  loadProviderConfiguration: vi.fn(() => ({ databaseUrl: "postgres://synthetic" })),
}));
vi.mock("../../../../lib/request-security", () => ({
  assertSameOrigin: vi.fn(),
  enforceRateLimit: vi.fn(),
}));
vi.mock("../../../../lib/scan-launcher", () => ({ launchScanNow }));

import { POST } from "./route";

const batchId = "11111111-1111-4111-8111-111111111111";
const request = (body: unknown) =>
  new NextRequest("http://127.0.0.1:3000/api/spotify/scan-control", {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", origin: "http://127.0.0.1:3000" },
    method: "POST",
  });

beforeEach(() => {
  vi.clearAllMocks();
  findLock.mockResolvedValue(undefined);
  getOperational.mockResolvedValue({ cooldownActive: false });
  pause.mockResolvedValue(true);
  resume.mockResolvedValue(true);
});

describe("Spotify scan control", () => {
  it("records a pause without launching another process", async () => {
    const response = await POST(request({ action: "pause", batchId }));
    expect(response.status).toBe(202);
    expect(pause).toHaveBeenCalledWith(expect.anything(), batchId);
    expect(launchScanNow).not.toHaveBeenCalled();
  });

  it("rejects resume during the global cooldown", async () => {
    getOperational.mockResolvedValue({ cooldownActive: true });
    const response = await POST(request({ action: "resume", batchId, confirmed: true }));
    expect(response.status).toBe(429);
    expect(resume).not.toHaveBeenCalled();
    expect(launchScanNow).not.toHaveBeenCalled();
  });

  it("resumes only the persisted batch through the normal scanner", async () => {
    const response = await POST(request({ action: "resume", batchId, confirmed: true }));
    expect(response.status).toBe(202);
    expect(launchScanNow).toHaveBeenCalledWith(undefined, process.env, expect.any(String), [
      "--provider",
      "spotify",
      "--spotify-batch",
      batchId,
      "--confirm-spotify-batch",
    ]);
  });
});
