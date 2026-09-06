import { AppleMusicClientError } from "@radar/providers";
import { describe, expect, it } from "vitest";

import { classifyAppleMusicFailure, resolveAppleMusicBatchFinalStatus } from "./apple-music-scan";

describe("Apple Music scan failure isolation", () => {
  it.each([
    ["temporary_server_error", 503],
    ["timeout", undefined],
    ["transport_error", undefined],
  ] as const)("continues after retryable per-artist %s failures", (classification, status) => {
    expect(
      classifyAppleMusicFailure(
        new AppleMusicClientError("temporary failure", classification, status),
      ),
    ).toMatchObject({
      artistStatus: "retryable",
      classification,
      continue: true,
      runStatus: "paused",
    });
  });

  it.each([400, 404])("records HTTP %s as terminal and continues", (status) => {
    expect(
      classifyAppleMusicFailure(
        new AppleMusicClientError("catalog record unavailable", "catalog_error", status),
      ),
    ).toMatchObject({
      artistStatus: "terminal",
      continue: true,
      runStatus: "paused",
    });
  });

  it("stops and preserves a provider-directed rate limit", () => {
    expect(
      classifyAppleMusicFailure(
        new AppleMusicClientError("rate limited", "rate_limited", 429, 120),
      ),
    ).toMatchObject({
      artistStatus: "retryable",
      classification: "rate_limited",
      continue: false,
      runStatus: "rate_limited",
    });
  });
});

describe("Apple Music resumed-batch completion", () => {
  it("uses the current persisted failure count after retryable artists recover", () => {
    expect(resolveAppleMusicBatchFinalStatus({ failedArtists: 0, remainingItems: 0 })).toBe(
      "completed",
    );
  });

  it.each([
    { failedArtists: 0, remainingItems: 1 },
    { failedArtists: 1, remainingItems: 0 },
  ])("keeps genuinely unfinished or failed batches partial", (input) => {
    expect(resolveAppleMusicBatchFinalStatus(input)).toBe("partial");
  });
});
