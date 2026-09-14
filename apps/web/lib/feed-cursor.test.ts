import { describe, expect, it } from "vitest";
import { createFeedCursor, parseFeedCursor, type FeedQueryFilters } from "./feed-cursor";

const filters: FeedQueryFilters = { provider: "spotify", search: "signal", sort: "release" };
const position = {
  firstSeenAt: "2026-07-21T20:00:00.000Z",
  releaseDate: "2026-07-20",
  releasePrecision: 3,
  stableId: "00000000-0000-4000-8000-000000000001",
};

describe("feed cursors", () => {
  it("round trips a signed query-bound position", () => {
    const token = createFeedCursor(position, filters, "test-secret");
    expect(parseFeedCursor(token, filters, "test-secret")).toEqual(position);
  });

  it("rejects tampering, another query, and malformed payloads", () => {
    const token = createFeedCursor(position, filters, "test-secret");
    expect(() => parseFeedCursor(`${token}x`, filters, "test-secret")).toThrow(/signature/);
    expect(() =>
      parseFeedCursor(token, { ...filters, search: "different" }, "test-secret"),
    ).toThrow(/current query/);
    expect(() => parseFeedCursor("not-a-cursor", filters, "test-secret")).toThrow(/malformed/);
  });
});
