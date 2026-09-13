import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { deactivateFollowedArtist, end, enforceRateLimit } = vi.hoisted(() => ({
  deactivateFollowedArtist: vi.fn(),
  end: vi.fn(() => Promise.resolve()),
  enforceRateLimit: vi.fn(),
}));

vi.mock("@radar/db", () => ({
  createDatabase: vi.fn(() => ({ client: { end }, db: {} })),
  deactivateFollowedArtist,
  ensureLocalOwner: vi.fn(() => Promise.resolve("11111111-1111-4111-8111-111111111111")),
}));
vi.mock("@radar/providers", () => ({
  loadProviderConfiguration: vi.fn(() => ({ databaseUrl: "postgres://synthetic" })),
}));
vi.mock("../../../../lib/request-security", () => ({
  assertSameOrigin: vi.fn(),
  enforceRateLimit,
}));

import { DELETE } from "./route";

const artistId = "22222222-2222-4222-8222-222222222222";
const request = new NextRequest(`http://127.0.0.1:3000/api/artists/${artistId}`, {
  headers: { origin: "http://127.0.0.1:3000" },
  method: "DELETE",
});
const context = { params: Promise.resolve({ id: artistId }) };

beforeEach(() => {
  vi.clearAllMocks();
  deactivateFollowedArtist.mockResolvedValue({
    alreadyInactive: false,
    artistId,
    blockedSpotifyWork: 2,
  });
});

describe("followed artist removal", () => {
  it("deactivates the local follow without deleting canonical evidence", async () => {
    const response = await DELETE(request, context);

    expect(response.status).toBe(200);
    expect(deactivateFollowedArtist).toHaveBeenCalledWith(
      expect.anything(),
      "11111111-1111-4111-8111-111111111111",
      artistId,
    );
    expect(enforceRateLimit).toHaveBeenCalledWith(expect.anything(), 60, 60_000, "/api/artists");
    await expect(response.json()).resolves.toEqual({
      removed: true,
      result: { alreadyInactive: false, artistId, blockedSpotifyWork: 2 },
    });
    expect(end).toHaveBeenCalledOnce();
  });

  it("returns not found for an artist outside the local watchlist", async () => {
    deactivateFollowedArtist.mockResolvedValue(undefined);

    const response = await DELETE(request, context);

    expect(response.status).toBe(404);
    expect(end).toHaveBeenCalledOnce();
  });

  it("rejects a malformed artist ID before opening the database", async () => {
    const response = await DELETE(request, {
      params: Promise.resolve({ id: "not-an-artist-id" }),
    });

    expect(response.status).toBe(400);
    expect(deactivateFollowedArtist).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });
});
