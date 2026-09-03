import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { deriveRoleConnectionStrings, readEnvValue } from "./showcase-neon-bootstrap";

describe("Showcase Neon bootstrap helpers", () => {
  it("reads only the requested environment value", () => {
    expect(
      readEnvValue(
        [
          "IGNORED=value",
          'SHOWCASE_NEON_OWNER_DATABASE_URL="postgresql://owner:secret@ep-demo.us-east-2.aws.neon.tech/neondb?sslmode=require"',
        ].join("\n"),
        "SHOWCASE_NEON_OWNER_DATABASE_URL",
      ),
    ).toBe("postgresql://owner:secret@ep-demo.us-east-2.aws.neon.tech/neondb?sslmode=require");
  });

  it("derives separate direct publisher and pooled website credentials", () => {
    const connections = deriveRoleConnectionStrings(
      "postgresql://owner:owner-secret@ep-demo.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
      "publisher-secret",
      "website-secret",
    );
    const publisher = new URL(connections.publisher);
    const website = new URL(connections.website);

    expect(publisher.username).toBe("showcase_publisher");
    expect(publisher.password).toBe("publisher-secret");
    expect(publisher.hostname).toBe("ep-demo.us-east-2.aws.neon.tech");
    expect(website.username).toBe("showcase_web_readonly");
    expect(website.password).toBe("website-secret");
    expect(website.hostname).toBe("ep-demo-pooler.us-east-2.aws.neon.tech");
    expect(connections.publisher).not.toContain("owner-secret");
    expect(connections.website).not.toContain("owner-secret");
  });

  it("rejects pooled, non-Neon, or non-TLS owner URLs", () => {
    expect(() =>
      deriveRoleConnectionStrings(
        "postgresql://owner:secret@ep-demo-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",
        "publisher",
        "website",
      ),
    ).toThrow(/direct Neon connection/u);
    expect(() =>
      deriveRoleConnectionStrings(
        "postgresql://owner:secret@example.com/neondb?sslmode=require",
        "publisher",
        "website",
      ),
    ).toThrow(/must target Neon/u);
    expect(() =>
      deriveRoleConnectionStrings(
        "postgresql://owner:secret@ep-demo.us-east-2.aws.neon.tech/neondb",
        "publisher",
        "website",
      ),
    ).toThrow(/require TLS/u);
  });

  it("keeps database writes behind the validated publisher function", async () => {
    const schema = await readFile(
      resolve("apps", "showcase", "neon", "0001_public_catalog.sql"),
      "utf8",
    );

    expect(schema).toContain("SECURITY DEFINER");
    expect(schema).toContain("SET search_path = pg_catalog, showcase");
    expect(schema).toContain(
      "GRANT EXECUTE ON FUNCTION showcase.publish_catalog(text, timestamptz, text, jsonb)",
    );
    expect(schema).toContain(
      "GRANT SELECT ON TABLE showcase.current_catalog TO showcase_publisher",
    );
    expect(schema).toContain(
      "GRANT SELECT ON TABLE showcase.current_catalog TO showcase_web_readonly",
    );
    expect(schema).not.toMatch(/GRANT\s+INSERT\s+ON[\s\S]*?TO\s+showcase_publisher/iu);
    expect(schema).not.toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+showcase\.publish_catalog\([^;]+?TO\s+showcase_web_readonly/iu,
    );
  });
});
