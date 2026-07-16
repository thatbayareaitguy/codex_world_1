import { describe, expect, it, vi } from "vitest";
import { redact, withRetry } from "./index";

describe("withRetry", () => {
  it("honors Retry-After and remains bounded", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValue("ok");

    await expect(
      withRetry(operation, {
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        sleep,
        shouldRetry: () => true,
        retryAfterMs: () => 250,
      }),
    ).resolves.toBe("ok");
    expect(sleep).toHaveBeenCalledWith(250);
  });
});

describe("redact", () => {
  it("removes nested token and authorization fields", () => {
    expect(redact({ accessToken: "secret", nested: { Authorization: "Bearer value" } })).toEqual({
      accessToken: "[REDACTED]",
      nested: { Authorization: "[REDACTED]" },
    });
  });
});
