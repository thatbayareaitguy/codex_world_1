import { describe, expect, it } from "vitest";

import { loadPublicCatalog } from "./catalog-source.server";
import { validateShowcasePublicDatabaseUrl } from "../../../scripts/showcase-neon-reader";
import { catalogAtDate } from "./catalog-dates";
import { publicCatalog } from "./public-catalog";

describe("Showcase catalog source", () => {
  it("uses the generated catalog when local JSON fallback is selected", async () => {
    await expect(
      loadPublicCatalog({
        environment: { NODE_ENV: "test", SHOWCASE_CATALOG_SOURCE: "json" },
      }),
    ).resolves.toEqual(catalogAtDate(publicCatalog, new Date()));
  });

  it("serves a Vercel snapshot without any database configuration", async () => {
    await expect(
      loadPublicCatalog({
        environment: { NODE_ENV: "test", SHOWCASE_CATALOG_SOURCE: "json", VERCEL: "1" },
      }),
    ).resolves.toHaveProperty("contractVersion", "showcase-public-v3");
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
