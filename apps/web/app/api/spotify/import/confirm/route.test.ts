import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { close, confirmSpotifyImport, revalidatePath } = vi.hoisted(() => ({
  close: vi.fn(() => Promise.resolve()),
  confirmSpotifyImport: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@radar/db", () => ({ confirmSpotifyImport }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("../../../../../lib/request-security", () => ({
  assertSameOrigin: vi.fn(),
  enforceRateLimit: vi.fn(),
}));
vi.mock("../../../../../lib/spotify-server", () => ({
  createSpotifyServerContext: vi.fn(() =>
    Promise.resolve({
      close,
      db: { synthetic: true },
      userId: "00000000-0000-4000-8000-000000000001",
    }),
  ),
}));

import { POST } from "./route";

const importRunId = "00000000-0000-4000-8000-000000000002";
const candidateId = "00000000-0000-4000-8000-000000000003";

beforeEach(() => {
  vi.clearAllMocks();
  confirmSpotifyImport.mockResolvedValue({
    alreadyPresent: 0,
    created: 1,
    failed: 0,
    merged: 0,
    needsReview: 0,
    persisted: 1,
    retrieved: 1,
    selected: 1,
    skipped: 0,
  });
});

describe("Spotify import confirmation route", () => {
  it("invalidates the database-backed page after persistence", async () => {
    const request = new NextRequest("http://127.0.0.1:3000/api/spotify/import/confirm", {
      body: JSON.stringify({
        decisions: [{ candidateId, decision: "create", selected: true }],
        importRunId,
      }),
      headers: { "Content-Type": "application/json", origin: "http://127.0.0.1:3000" },
      method: "POST",
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(revalidatePath).toHaveBeenCalledWith("/");
    expect(close).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toMatchObject({ created: 1, persisted: 1 });
  });
});
