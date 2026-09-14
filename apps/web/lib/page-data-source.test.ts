import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createInitialPageDataSource } from "./page-data-source";

describe("web page data source", () => {
  it("never substitutes fixture records in normal application mode", () => {
    expect(createInitialPageDataSource(["fixture-release"], false)).toEqual({
      feedMode: "error",
      initialItems: [],
      watchlistMode: "error",
    });
  });

  it("keeps fixture records available behind explicit mock mode", () => {
    expect(createInitialPageDataSource(["fixture-release"], true)).toEqual({
      feedMode: "mock",
      initialItems: ["fixture-release"],
      watchlistMode: "mock",
    });
  });

  it("loads the workspace environment for every web lifecycle command", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), "apps", "web", "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    for (const command of ["build", "dev", "start"]) {
      expect(packageJson.scripts[command]).toContain("scripts/next-with-workspace-env.ts");
    }

    const launcher = readFileSync(
      resolve(process.cwd(), "apps", "web", "scripts", "next-with-workspace-env.ts"),
      "utf8",
    );
    expect(launcher).toContain("process.loadEnvFile(workspaceEnvironmentPath)");
    expect(launcher).toContain("Object.assign(process.env, inheritedEnvironment)");
  });
});
