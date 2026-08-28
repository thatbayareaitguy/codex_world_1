import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const e2eRuntimeDirectory = resolve("apps", "showcase", ".app-runtime");

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
      SHOWCASE_GENRE_ADMIN_ENABLED: "true",
      SHOWCASE_CONFIRMED_GENRES_PATH: resolve(e2eRuntimeDirectory, "e2e-confirmed-genres.json"),
      SHOWCASE_GENRE_REVIEW_PATH: resolve(e2eRuntimeDirectory, "e2e-genre-reviews.json"),
    },
    url: "http://127.0.0.1:3201",
    reuseExistingServer: false,
    timeout: 120000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chrome" } }],
});
