import { describe, expect, it, vi } from "vitest";
import { RedditClient, RedditGlobalRateLimiter } from "./reddit";
import type { RedditConfigurationError } from "./reddit";

const validConfiguration = {
  accessApproved: true,
  clientId: "fixture-client",
  clientSecret: "fixture-secret",
  enabled: true,
  internalMaxQpm: 30,
  userAgent: "web:ts-new-music-radar:v0.1.0 (by /u/fixture_owner)",
};

const syntheticRedditListing = {
  kind: "Listing",
  data: {
    after: "t3_fixture1",
    children: [
      {
        kind: "t3",
        data: {
          author: "must_be_stripped",
          created_utc: 1_784_150_400,
          edited: false,
          id: "fixture1",
          is_self: false,
          link_flair_text: "Fresh",
          name: "t3_fixture1",
          permalink: "/r/EDM/comments/fixture1/synthetic/",
          removed_by_category: null,
          score: 999,
          selftext: "",
          subreddit: "EDM",
          title: "Artist - Synthetic Track",
          url: "https://example.test/synthetic",
        },
      },
    ],
  },
};

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

const tokenResponse = () =>
  response({
    access_token: "fixture-token",
    expires_in: 3600,
    token_type: "bearer",
    scope: "read",
  });

function requestBody(value: BodyInit | null | undefined): string {
  return typeof value === "string" || value instanceof URLSearchParams ? value.toString() : "";
}

function requestUrl(value: RequestInfo | URL | undefined): string {
  if (value instanceof Request) return value.url;
  if (value instanceof URL) return value.toString();
  return value ?? "";
}

describe("Reddit approval and authentication", () => {
  it.each([
    [{ ...validConfiguration, enabled: false }, "REDDIT_DISABLED"],
    [{ ...validConfiguration, accessApproved: false }, "REDDIT_APPROVAL_REQUIRED"],
    [
      {
        accessApproved: true,
        clientSecret: "fixture-secret",
        enabled: true,
        userAgent: validConfiguration.userAgent,
      },
      "REDDIT_CREDENTIALS_MISSING",
    ],
    [
      {
        accessApproved: true,
        clientId: "fixture-client",
        enabled: true,
        userAgent: validConfiguration.userAgent,
      },
      "REDDIT_CREDENTIALS_MISSING",
    ],
    [{ ...validConfiguration, userAgent: "node" }, "REDDIT_USER_AGENT_INVALID"],
  ] as const)("blocks invalid gate configuration", async (configuration, code) => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new RedditClient(configuration, { fetch: fetchMock });
    await expect(client.listNew({ subreddit: "EDM" })).rejects.toMatchObject({
      code,
      name: "RedditConfigurationError",
    } satisfies Partial<RedditConfigurationError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retrieves and caches an application-only token", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(response(syntheticRedditListing))
      .mockResolvedValueOnce(response(syntheticRedditListing));
    const client = new RedditClient(validConfiguration, { fetch: fetchMock });
    await client.listNew({ subreddit: "EDM" });
    await client.listNew({ subreddit: "EDM" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestBody(fetchMock.mock.calls[0]?.[1]?.body)).toBe("grant_type=client_credentials");
    expect(requestBody(fetchMock.mock.calls[0]?.[1]?.body)).not.toContain("password");
  });

  it("never falls back to an unauthenticated request", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(response({ error: "forbidden" }, 403));
    const client = new RedditClient(validConfiguration, { fetch: fetchMock });
    await expect(client.listNew({ subreddit: "EDM" })).rejects.toThrow("403");
    const apiHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(apiHeaders.get("authorization")).toBe("Bearer fixture-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes once after an unauthorized API response", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(response(syntheticRedditListing));
    const client = new RedditClient(validConfiguration, { fetch: fetchMock });
    await expect(client.listNew({ subreddit: "EDM" })).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("Reddit read-only endpoints", () => {
  it("uses after pagination and clamps listing size to 100", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(response(syntheticRedditListing));
    const client = new RedditClient(validConfiguration, { fetch: fetchMock });
    await client.listNew({ after: "t3_fixture0", limit: 500, subreddit: "EDM" });
    expect(requestUrl(fetchMock.mock.calls[1]?.[0])).toContain(
      "/r/EDM/new?limit=100&after=t3_fixture0",
    );
  });

  it("restricts explicit search to one subreddit", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(response(syntheticRedditListing));
    const client = new RedditClient(validConfiguration, { fetch: fetchMock });
    await client.search({ query: "Lumen Field", subreddit: "dubstep" });
    const url = requestUrl(fetchMock.mock.calls[1]?.[0]);
    expect(url).toContain("/r/dubstep/search?");
    expect(url).toContain("restrict_sr=true");
    expect(url).toContain("sort=new");
  });

  it("uses api info only with valid submission fullnames", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(response(syntheticRedditListing));
    const client = new RedditClient(validConfiguration, { fetch: fetchMock });
    await client.info(["t3_fixture1", "unsafe", "t3_fixture2", "t3_fixture1"]);
    expect(requestUrl(fetchMock.mock.calls[1]?.[0])).toContain("%2C");
    expect(requestUrl(fetchMock.mock.calls[1]?.[0])).not.toContain("unsafe");
  });

  it("does not retain author or score fields after validation", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(response(syntheticRedditListing));
    const listing = await new RedditClient(validConfiguration, { fetch: fetchMock }).listNew({
      subreddit: "EDM",
    });
    expect(listing.data.children[0]?.data).not.toHaveProperty("author");
    expect(listing.data.children[0]?.data).not.toHaveProperty("score");
  });

  it.each(["r/EDM/new", "../EDM", "EDM?sort=hot"])(
    "rejects path injection in subreddit %s",
    async (subreddit) => {
      const fetchMock = vi.fn<typeof fetch>();
      const client = new RedditClient(validConfiguration, { fetch: fetchMock });
      await expect(client.listNew({ subreddit })).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("Reddit rate limiting and retries", () => {
  it("parses Reddit rate-limit response headers", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        response(syntheticRedditListing, 200, {
          "x-ratelimit-remaining": "88",
          "x-ratelimit-reset": "60",
          "x-ratelimit-used": "12",
        }),
      );
    const client = new RedditClient(validConfiguration, { fetch: fetchMock });
    await client.listNew({ subreddit: "EDM" });
    expect(client.metrics()).toMatchObject({ remaining: 88, requests: 1, used: 12 });
  });

  it("enforces the internal per-minute limit globally", async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new RedditGlobalRateLimiter(
      2,
      () => now,
      (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
        return Promise.resolve();
      },
    );
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(waits).toEqual([60_000]);
  });

  it("honors Retry-After for 429 responses", async () => {
    const waits: number[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(response({}, 429, { "retry-after": "2" }))
      .mockResolvedValueOnce(response(syntheticRedditListing));
    const client = new RedditClient(validConfiguration, {
      fetch: fetchMock,
      sleep: (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
    });
    await client.listNew({ subreddit: "EDM" });
    expect(waits).toContain(2_000);
  });

  it("retries transient server failures with bounded backoff", async () => {
    const waits: number[] = [];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValueOnce(response(syntheticRedditListing));
    const client = new RedditClient(validConfiguration, {
      fetch: fetchMock,
      random: () => 0,
      sleep: (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
    });
    await client.listNew({ subreddit: "EDM" });
    expect(waits).toContain(500);
  });

  it("does not retry permanent authentication or approval failures", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(response({}, 403));
    const client = new RedditClient(validConfiguration, { fetch: fetchMock });
    await expect(client.listNew({ subreddit: "EDM" })).rejects.toThrow("403");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
