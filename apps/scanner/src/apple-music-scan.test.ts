import { AppleMusicClientError } from "@radar/providers";
import { describe, expect, it } from "vitest";

import { classifyAppleMusicFailure } from "./apple-music-scan";

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
