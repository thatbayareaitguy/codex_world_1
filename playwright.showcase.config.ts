import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/showcase/e2e",
  fullyParallel: true,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:3201", trace: "retain-on-failure" },
  webServer: {
    command:
      "pnpm --filter @showcase/web build && pnpm --filter @showcase/web start --hostname 127.0.0.1 --port 3201",
    env: { NEXT_DIST_DIR: ".next-e2e" },
    url: "http://127.0.0.1:3201",
    reuseExistingServer: false,
    timeout: 120000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chrome" } }],
});
