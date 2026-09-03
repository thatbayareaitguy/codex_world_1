import { describe, expect, it } from "vitest";

import {
  catalogContentSha256,
  validateShowcasePublisherDatabaseUrl,
} from "./showcase-neon-publication";

describe("Showcase Neon publication", () => {
  it("accepts only the direct restricted publisher connection", () => {
    const valid =
      "postgresql://showcase_publisher:secret@ep-demo.us-east-2.aws.neon.tech/neondb?sslmode=require";
    expect(validateShowcasePublisherDatabaseUrl(valid)).toContain("showcase_publisher");
    expect(() =>
      validateShowcasePublisherDatabaseUrl(
        "postgresql://owner:secret@ep-demo.us-east-2.aws.neon.tech/neondb?sslmode=require",
      ),
    ).toThrow(/restricted publisher role/u);
    expect(() =>
      validateShowcasePublisherDatabaseUrl(
        "postgresql://showcase_publisher:secret@ep-demo-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",
      ),
    ).toThrow(/direct Neon endpoint/u);
  });

  it("hashes equivalent catalog objects deterministically", () => {
    expect(catalogContentSha256({ releases: [], contractVersion: "showcase-public-v3" })).toBe(
      catalogContentSha256({ contractVersion: "showcase-public-v3", releases: [] }),
    );
  });
});
