import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadConfiguration, loadPage, loadRevision } = vi.hoisted(() => ({
  loadConfiguration: vi.fn(),
  loadPage: vi.fn(),
  loadRevision: vi.fn(),
}));

vi.mock("@radar/providers", () => ({ loadProviderConfiguration: loadConfiguration }));
vi.mock("../../../lib/feed-server", () => ({
  loadDatabaseFeedRevision: loadRevision,
  loadDatabaseFeedPage: loadPage,
}));

import { GET } from "./route";

describe("discovery feed API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfiguration.mockReturnValue({
      appEncryptionKey: "test-feed-cursor-secret",
      databaseUrl: "postgres://database.test/radar",
    });
  });

  it("uses the lightweight revision query when requested", async () => {
    loadRevision.mockResolvedValue({ count: 4, revision: "2026-07-19T12:00:00.000Z:4" });

    const response = await GET(new Request("http://localhost/api/feed?mode=revision"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      count: 4,
      revision: "2026-07-19T12:00:00.000Z:4",
    });
    expect(loadRevision).toHaveBeenCalledWith("postgres://database.test/radar");
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("loads a validated bounded page for a full refresh", async () => {
    loadPage.mockResolvedValue({
      count: 0,
      hasMore: false,
      items: [],
      nextCursor: null,
      revision: "empty:0",
      summary: { needsReview: 0, newThisWeek: 0, upcoming: 0 },
      totalCount: 0,
    });

    const response = await GET(new Request("http://localhost/api/feed"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      count: 0,
      hasMore: false,
      items: [],
      revision: "empty:0",
    });
    expect(loadPage).toHaveBeenCalledWith("postgres://database.test/radar", {
      filters: { sort: "release" },
      limit: 100,
      secret: "test-feed-cursor-secret",
    });
    expect(loadRevision).not.toHaveBeenCalled();
  });

  it("rejects an invalid cursor before querying the database", async () => {
    loadPage.mockRejectedValue(new Error("Feed cursor signature is invalid"));
    const response = await GET(new Request("http://localhost/api/feed?cursor=forged"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid feed query" });
  });

  it("returns a safe error when the database refresh fails", async () => {
    loadRevision.mockRejectedValue(new Error("database details must stay server-side"));

    const response = await GET(new Request("http://localhost/api/feed?mode=revision"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Unable to refresh the discovery feed",
    });
  });
});
