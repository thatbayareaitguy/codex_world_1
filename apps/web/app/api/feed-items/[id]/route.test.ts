import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { end, updateFeedPreferences } = vi.hoisted(() => ({
  end: vi.fn(() => Promise.resolve()),
  updateFeedPreferences: vi.fn(),
}));

vi.mock("@radar/db", () => ({
  createDatabase: vi.fn(() => ({ client: { end }, db: {} })),
  ensureLocalOwner: vi.fn(() => Promise.resolve("11111111-1111-4111-8111-111111111111")),
  updateFeedPreferences,
}));
vi.mock("@radar/providers", () => ({
  loadProviderConfiguration: vi.fn(() => ({ databaseUrl: "postgres://synthetic" })),
}));
vi.mock("../../../../lib/request-security", () => ({
  assertSameOrigin: vi.fn(),
  enforceRateLimit: vi.fn(),
}));

import { PATCH } from "./route";

const feedItemId = "22222222-2222-4222-8222-222222222222";
const request = (body: unknown) =>
  new NextRequest(`http://127.0.0.1:3000/api/feed-items/${feedItemId}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", origin: "http://127.0.0.1:3000" },
    method: "PATCH",
  });
const context = { params: Promise.resolve({ id: feedItemId }) };

beforeEach(() => {
  vi.clearAllMocks();
  updateFeedPreferences.mockResolvedValue({
    id: feedItemId,
    listened: true,
    saved: true,
    state: "new",
  });
});

describe("feed item preferences", () => {
  it("updates saved and listened independently", async () => {
    const response = await PATCH(request({ listened: true }), context);
    expect(response.status).toBe(200);
    expect(updateFeedPreferences).toHaveBeenCalledWith(
      expect.anything(),
      "11111111-1111-4111-8111-111111111111",
      feedItemId,
      { listened: true },
    );
    await expect(response.json()).resolves.toMatchObject({
      item: { listened: true, saved: true, state: "new" },
    });
  });

  it("rejects a request without a preference", async () => {
    const response = await PATCH(request({}), context);
    expect(response.status).toBe(400);
    expect(updateFeedPreferences).not.toHaveBeenCalled();
  });

  it("returns not found without creating a row", async () => {
    updateFeedPreferences.mockResolvedValue(undefined);
    const response = await PATCH(request({ saved: true }), context);
    expect(response.status).toBe(404);
  });
});
