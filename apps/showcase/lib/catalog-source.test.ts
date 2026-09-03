import { describe, expect, it } from "vitest";

import { loadPublicCatalog, validateShowcasePublicDatabaseUrl } from "./catalog-source.server";
import { publicCatalog } from "./public-catalog";

describe("Showcase catalog source", () => {
  it("uses the generated catalog when local JSON fallback is selected", async () => {
    await expect(
      loadPublicCatalog({
        environment: { NODE_ENV: "test", SHOWCASE_CATALOG_SOURCE: "json" },
      }),
    ).resolves.toBe(publicCatalog);
  });

  it("requires Neon for a Vercel deployment", async () => {
    await expect(
      loadPublicCatalog({
        environment: { NODE_ENV: "test", SHOWCASE_CATALOG_SOURCE: "json", VERCEL: "1" },
      }),
    ).rejects.toThrow(/must use Neon/u);
  });

  it("accepts only the pooled read-only website connection", () => {
    const valid =
      "postgresql://showcase_web_readonly:secret@ep-demo-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";
    expect(validateShowcasePublicDatabaseUrl(valid)).toContain("showcase_web_readonly");
    expect(() =>
      validateShowcasePublicDatabaseUrl(
        "postgresql://showcase_publisher:secret@ep-demo-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",
      ),
    ).toThrow(/read-only website role/u);
    expect(() =>
      validateShowcasePublicDatabaseUrl(
        "postgresql://showcase_web_readonly:secret@ep-demo.us-east-2.aws.neon.tech/neondb?sslmode=require",
      ),
    ).toThrow(/pooled Neon endpoint/u);
  });
});
