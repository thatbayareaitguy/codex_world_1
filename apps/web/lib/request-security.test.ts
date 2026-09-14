import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { enforceRateLimit } from "./request-security";

function request(path: string) {
  return new NextRequest(`http://127.0.0.1:3000${path}`, {
    headers: { "user-agent": "synthetic-browser" },
  });
}

describe("request rate limiting", () => {
  it("keeps unrelated API routes in separate counters", () => {
    expect(() => enforceRateLimit(request("/api/route-a"), 1)).not.toThrow();
    expect(() => enforceRateLimit(request("/api/route-b"), 1)).not.toThrow();
    expect(() => enforceRateLimit(request("/api/route-a"), 1)).toThrow("Too many requests");
  });

  it("supports a stable route-family scope for parameterized review routes", () => {
    expect(() =>
      enforceRateLimit(request("/api/feed-items/one"), 2, 60_000, "/api/feed-items"),
    ).not.toThrow();
    expect(() =>
      enforceRateLimit(request("/api/feed-items/two"), 2, 60_000, "/api/feed-items"),
    ).not.toThrow();
    expect(() =>
      enforceRateLimit(request("/api/feed-items/three"), 2, 60_000, "/api/feed-items"),
    ).toThrow("Too many requests");
  });
});
