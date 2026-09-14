import { z } from "zod";
import { isValidRedditUserAgent } from "./config";
import { validateSubredditName } from "./reddit-parser";

const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const REDDIT_API_BASE_URL = "https://oauth.reddit.com";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
  token_type: z.string().toLowerCase().pipe(z.literal("bearer")),
});

const redditSubmissionSchema = z.object({
  created_utc: z.number().finite(),
  crosspost_parent: z
    .string()
    .regex(/^t3_[a-z0-9]+$/)
    .optional(),
  edited: z.union([z.number().finite(), z.literal(false)]).optional(),
  id: z.string().regex(/^[a-z0-9]+$/),
  is_self: z.boolean(),
  link_flair_text: z.string().nullable().optional(),
  name: z.string().regex(/^t3_[a-z0-9]+$/),
  permalink: z.string().startsWith("/"),
  removed_by_category: z.string().nullable().optional(),
  selftext: z.string().max(50_000).default(""),
  subreddit: z.string().min(1).max(100),
  title: z.string().max(1_000),
  url: z.string().max(4_096),
});

const listingSchema = z.object({
  data: z.object({
    after: z.string().nullable(),
    children: z.array(z.object({ data: redditSubmissionSchema, kind: z.literal("t3") })),
  }),
  kind: z.literal("Listing"),
});

export type RedditSubmission = z.infer<typeof redditSubmissionSchema>;
export type RedditListing = z.infer<typeof listingSchema>;

export interface RedditClientConfiguration {
  accessApproved: boolean;
  clientId?: string;
  clientSecret?: string;
  enabled: boolean;
  internalMaxQpm?: number;
  requestTimeoutMs?: number;
  userAgent?: string;
}

export interface RedditRateLimitSnapshot {
  failures: number;
  remaining?: number;
  requests: number;
  resetAt?: string;
  used?: number;
  waitMs: number;
}

export class RedditConfigurationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "REDDIT_DISABLED"
      | "REDDIT_APPROVAL_REQUIRED"
      | "REDDIT_CREDENTIALS_MISSING"
      | "REDDIT_USER_AGENT_INVALID",
  ) {
    super(message);
    this.name = "RedditConfigurationError";
  }
}

export function assertRedditAccessGate(
  configuration: RedditClientConfiguration,
): asserts configuration is RedditClientConfiguration & {
  clientId: string;
  clientSecret: string;
  userAgent: string;
} {
  if (!configuration.enabled) {
    throw new RedditConfigurationError("Reddit is disabled.", "REDDIT_DISABLED");
  }
  if (!configuration.accessApproved) {
    throw new RedditConfigurationError(
      "Reddit API approval required. Record approval only after Reddit grants it.",
      "REDDIT_APPROVAL_REQUIRED",
    );
  }
  if (!configuration.clientId || !configuration.clientSecret) {
    throw new RedditConfigurationError(
      "Reddit client credentials are not configured.",
      "REDDIT_CREDENTIALS_MISSING",
    );
  }
  if (!isValidRedditUserAgent(configuration.userAgent)) {
    throw new RedditConfigurationError(
      "Reddit User-Agent must identify platform, app, version, and contact username.",
      "REDDIT_USER_AGENT_INVALID",
    );
  }
}

export class RedditGlobalRateLimiter {
  private readonly requestTimes: number[] = [];
  private headerRemaining?: number;
  private headerResetAt?: number;
  private waits = 0;

  constructor(
    private readonly maxQpm = 30,
    private readonly now: () => number = Date.now,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {
    if (!Number.isInteger(maxQpm) || maxQpm < 1 || maxQpm > 99) {
      throw new Error("Reddit internal QPM must be between 1 and 99.");
    }
  }

  async acquire(): Promise<number> {
    let waited = 0;
    while (true) {
      const now = this.now();
      while (this.requestTimes[0] !== undefined && this.requestTimes[0] <= now - 60_000) {
        this.requestTimes.shift();
      }
      const headerWait =
        this.headerRemaining !== undefined &&
        this.headerRemaining <= 1 &&
        this.headerResetAt !== undefined
          ? Math.max(0, this.headerResetAt - now)
          : 0;
      const windowWait =
        this.requestTimes.length >= this.maxQpm && this.requestTimes[0] !== undefined
          ? Math.max(1, this.requestTimes[0] + 60_000 - now)
          : 0;
      const wait = Math.max(headerWait, windowWait);
      if (wait === 0) {
        this.requestTimes.push(this.now());
        this.waits += waited;
        return waited;
      }
      await this.sleep(wait);
      waited += wait;
      if (waited > 10 * 60_000) throw new Error("Reddit rate-limit wait exceeded ten minutes.");
    }
  }

  observe(headers: Headers): { remaining?: number; resetAt?: number; used?: number } {
    const used = finiteHeader(headers, "x-ratelimit-used");
    const remaining = finiteHeader(headers, "x-ratelimit-remaining");
    const resetSeconds = finiteHeader(headers, "x-ratelimit-reset");
    if (remaining !== undefined) this.headerRemaining = remaining;
    if (resetSeconds !== undefined) this.headerResetAt = this.now() + resetSeconds * 1_000;
    return {
      ...(used !== undefined ? { used } : {}),
      ...(remaining !== undefined ? { remaining } : {}),
      ...(this.headerResetAt !== undefined ? { resetAt: this.headerResetAt } : {}),
    };
  }

  get totalWaitMs(): number {
    return this.waits;
  }
}

export interface RedditClientDependencies {
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class RedditClient {
  private accessToken: { expiresAt: number; value: string } | undefined;
  private failures = 0;
  private requests = 0;
  private lastRateLimit: { remaining?: number; resetAt?: number; used?: number } = {};
  private readonly fetchImplementation: typeof fetch;
  private readonly limiter: RedditGlobalRateLimiter;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly configuration: RedditClientConfiguration,
    dependencies: RedditClientDependencies = {},
  ) {
    this.fetchImplementation = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
    this.sleep =
      dependencies.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.limiter = new RedditGlobalRateLimiter(
      configuration.internalMaxQpm ?? 30,
      this.now,
      this.sleep,
    );
  }

  async listNew(input: {
    after?: string;
    limit?: number;
    signal?: AbortSignal;
    subreddit: string;
  }): Promise<RedditListing> {
    const subreddit = requireSubreddit(input.subreddit);
    const parameters = new URLSearchParams({ limit: String(clampListingLimit(input.limit)) });
    if (input.after) parameters.set("after", input.after);
    return this.getListing(`/r/${encodeURIComponent(subreddit)}/new?${parameters}`, input.signal);
  }

  async search(input: {
    after?: string;
    limit?: number;
    query: string;
    signal?: AbortSignal;
    subreddit: string;
  }): Promise<RedditListing> {
    const subreddit = requireSubreddit(input.subreddit);
    const query = input.query.trim().slice(0, 512);
    if (!query) throw new Error("Reddit search query is required.");
    const parameters = new URLSearchParams({
      limit: String(clampListingLimit(input.limit)),
      q: query,
      restrict_sr: "true",
      sort: "new",
    });
    if (input.after) parameters.set("after", input.after);
    return this.getListing(
      `/r/${encodeURIComponent(subreddit)}/search?${parameters}`,
      input.signal,
    );
  }

  async info(fullnames: string[], signal?: AbortSignal): Promise<RedditListing> {
    const ids = [...new Set(fullnames)]
      .filter((value) => /^t3_[a-z0-9]+$/.test(value))
      .slice(0, 100);
    if (ids.length === 0)
      throw new Error("At least one valid Reddit submission fullname is required.");
    const parameters = new URLSearchParams({ id: ids.join(",") });
    return this.getListing(`/api/info?${parameters}`, signal);
  }

  metrics(): RedditRateLimitSnapshot {
    return {
      failures: this.failures,
      requests: this.requests,
      waitMs: this.limiter.totalWaitMs,
      ...(this.lastRateLimit.used !== undefined ? { used: this.lastRateLimit.used } : {}),
      ...(this.lastRateLimit.remaining !== undefined
        ? { remaining: this.lastRateLimit.remaining }
        : {}),
      ...(this.lastRateLimit.resetAt !== undefined
        ? { resetAt: new Date(this.lastRateLimit.resetAt).toISOString() }
        : {}),
    };
  }

  private async getListing(path: string, signal?: AbortSignal): Promise<RedditListing> {
    const response = await this.request(path, signal);
    const payload: unknown = await response.json();
    return listingSchema.parse(payload);
  }

  private async request(path: string, signal?: AbortSignal): Promise<Response> {
    assertRedditAccessGate(this.configuration);
    let refreshedAfterUnauthorized = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.limiter.acquire();
      const token = await this.getToken(signal);
      this.requests += 1;
      let response: Response;
      try {
        response = await this.fetchWithTimeout(
          `${REDDIT_API_BASE_URL}${path}`,
          {
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${token}`,
              "User-Agent": this.configuration.userAgent,
            },
            method: "GET",
          },
          signal,
        );
      } catch (error) {
        this.failures += 1;
        if (attempt === 3 || isAbortError(error)) throw error;
        await this.sleep(backoffMs(attempt, this.random));
        continue;
      }
      this.lastRateLimit = this.limiter.observe(response.headers);
      if (response.ok) return response;
      if (response.status === 401 && !refreshedAfterUnauthorized) {
        refreshedAfterUnauthorized = true;
        this.accessToken = undefined;
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        this.failures += 1;
        if (attempt === 3) throw redditHttpError(response);
        await this.sleep(retryDelayMs(response.headers, attempt, this.random));
        continue;
      }
      this.failures += 1;
      throw redditHttpError(response);
    }
    throw new Error("Reddit request retry budget exhausted.");
  }

  private async getToken(signal?: AbortSignal): Promise<string> {
    assertRedditAccessGate(this.configuration);
    if (this.accessToken && this.accessToken.expiresAt - 30_000 > this.now()) {
      return this.accessToken.value;
    }
    const credentials = Buffer.from(
      `${this.configuration.clientId}:${this.configuration.clientSecret}`,
      "utf8",
    ).toString("base64");
    const response = await this.fetchWithTimeout(
      REDDIT_TOKEN_URL,
      {
        body: new URLSearchParams({ grant_type: "client_credentials" }),
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": this.configuration.userAgent,
        },
        method: "POST",
      },
      signal,
    );
    if (!response.ok) throw redditHttpError(response);
    const token = tokenSchema.parse(await response.json());
    this.accessToken = {
      expiresAt: this.now() + token.expires_in * 1_000,
      value: token.access_token,
    };
    return token.access_token;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    parentSignal?: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(this.configuration.requestTimeoutMs ?? 15_000);
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
    return this.fetchImplementation(url, { ...init, signal });
  }
}

export interface RedditCommentReader {
  readonly implementationStatus: "deferred";
}

function requireSubreddit(value: string): string {
  const result = validateSubredditName(value);
  if (!result.valid) throw new Error(result.error);
  return result.normalized;
}

function clampListingLimit(value = 100): number {
  return Math.max(1, Math.min(100, Math.trunc(value)));
}

function finiteHeader(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function retryDelayMs(headers: Headers, attempt: number, random: () => number): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(120_000, seconds * 1_000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, Math.min(120_000, date - Date.now()));
  }
  return backoffMs(attempt, random);
}

function backoffMs(attempt: number, random: () => number): number {
  return Math.min(30_000, 500 * 2 ** attempt + Math.floor(random() * 250));
}

function redditHttpError(response: Response): Error {
  const requestId = response.headers.get("x-reddit-trace-id");
  return new Error(
    `Reddit API request failed with ${response.status}${requestId ? ` (request ${requestId})` : ""}.`,
  );
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")
  );
}
