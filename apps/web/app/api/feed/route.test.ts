import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadConfiguration, loadRevision, loadSnapshot } = vi.hoisted(() => ({
  loadConfiguration: vi.fn(),
  loadRevision: vi.fn(),
  loadSnapshot: vi.fn(),
}));

vi.mock("@radar/providers", () => ({ loadProviderConfiguration: loadConfiguration }));
vi.mock("../../../lib/feed-server", () => ({
  loadDatabaseFeedRevision: loadRevision,
  loadDatabaseFeedSnapshot: loadSnapshot,
}));

import { GET } from "./route";

describe("discovery feed API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfiguration.mockReturnValue({ databaseUrl: "postgres://database.test/radar" });
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
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it("loads the full snapshot only for a full refresh", async () => {
    loadSnapshot.mockResolvedValue({ count: 0, items: [], revision: "empty:0" });

    const response = await GET(new Request("http://localhost/api/feed"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ count: 0, items: [], revision: "empty:0" });
    expect(loadSnapshot).toHaveBeenCalledWith("postgres://database.test/radar");
    expect(loadRevision).not.toHaveBeenCalled();
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
