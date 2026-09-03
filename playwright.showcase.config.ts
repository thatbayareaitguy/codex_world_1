import { defineConfig, devices } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const e2eRuntimeDirectory = resolve("apps", "showcase", ".app-runtime");
const e2eCatalogSource = process.env.SHOWCASE_E2E_CATALOG_SOURCE === "neon" ? "neon" : "json";

function neonE2eEnvironment(): Record<string, string> {
  if (e2eCatalogSource !== "neon") return {};
  const localData = process.env.LOCALAPPDATA;
  if (localData === undefined || localData.trim() === "") {
    throw new Error("LOCALAPPDATA is required for live Showcase Neon browser verification.");
  }
  const source = readFileSync(resolve(localData, "Showcase", "neon-public-web.env"), "utf8");
  const line = source
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith("SHOWCASE_NEON_PUBLIC_DATABASE_URL="));
  if (line === undefined) throw new Error("The local Showcase read-only credential is missing.");
  const rawValue = line.slice(line.indexOf("=") + 1).trim();
  const value =
    rawValue.length >= 2 &&
    ((rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'")))
      ? rawValue.slice(1, -1)
      : rawValue;
  if (value === "") throw new Error("The local Showcase read-only credential is empty.");
  return { SHOWCASE_NEON_PUBLIC_DATABASE_URL: value };
}

export default defineConfig({
  testDir: "./apps/showcase/e2e",
  globalSetup: "./apps/showcase/e2e/setup.ts",
  fullyParallel: true,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:3201", trace: "retain-on-failure" },
  webServer: {
    command:
      "pnpm --filter @showcase/web build && pnpm --filter @showcase/web start --hostname 127.0.0.1 --port 3201",
    env: {
      NEXT_DIST_DIR: ".next-e2e",
      SHOWCASE_CATALOG_SOURCE: e2eCatalogSource,
      SHOWCASE_GENRE_ADMIN_ENABLED: "true",
      SHOWCASE_CONFIRMED_GENRES_PATH: resolve(e2eRuntimeDirectory, "e2e-confirmed-genres.json"),
      SHOWCASE_GENRE_REVIEW_PATH: resolve(e2eRuntimeDirectory, "e2e-genre-reviews.json"),
      SHOWCASE_GENRE_EVIDENCE_PATH: resolve(e2eRuntimeDirectory, "e2e-genre-evidence.json"),
      ...neonE2eEnvironment(),
    },
    url: "http://127.0.0.1:3201",
    reuseExistingServer: false,
    timeout: 120000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chrome" } }],
});
