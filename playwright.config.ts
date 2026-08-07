import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  fullyParallel: true,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
  webServer: {
    command:
      "pnpm --filter @radar/web build && pnpm --filter @radar/web start --hostname 127.0.0.1 --port 3100",
    env: {
      APP_BASE_URL: "http://127.0.0.1:3100",
      APP_ENCRYPTION_KEY: "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=",
      DATABASE_URL: "postgres://radar:radar@127.0.0.1:5433/radar_test",
      MUSICBRAINZ_CONTACT_EMAIL: "e2e@example.com",
      MUSICBRAINZ_ENABLED: "false",
      NEXT_DIST_DIR: ".next-e2e",
      RADAR_E2E_MOCK_MODE: "true",
      SPOTIFY_CLIENT_ID: "e2e-client-id",
      SPOTIFY_CLIENT_SECRET: "e2e-client-secret",
      SPOTIFY_ENABLED: "true",
      SPOTIFY_ALLOWED_PLAYLIST_ID: "1234567890123456789012",
      SPOTIFY_PLAYLIST_WRITES_ENABLED: "true",
      SPOTIFY_REDIRECT_URI: "http://127.0.0.1:3100/api/auth/spotify/callback",
    },
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 120000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chrome" } }],
});
