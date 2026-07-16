import { describe, expect, it } from "vitest";
import { loadProviderConfiguration } from "./config";

describe("provider configuration", () => {
  it("starts without credentials and hides manual SoundCloud links", () => {
    const config = loadProviderConfiguration({});

    expect(config.spotify).toMatchObject({ enabled: true, configured: false });
    expect(config.musicbrainz).toMatchObject({ enabled: true, configured: false });
    expect(config.soundcloudManualLinksEnabled).toBe(false);
    expect(config.initialBackfillDays).toBe(60);
  });

  it("validates typed feature flags", () => {
    const config = loadProviderConfiguration({
      APP_ENCRYPTION_KEY: "test-key",
      MUSICBRAINZ_CONTACT_EMAIL: "owner@example.test",
      MUSICBRAINZ_ENABLED: "false",
      SOUNDCLOUD_MANUAL_LINKS_ENABLED: "true",
      SPOTIFY_CLIENT_ID: "client",
      SPOTIFY_CLIENT_SECRET: "secret",
      SPOTIFY_ENABLED: "false",
    });

    expect(config.spotify).toMatchObject({ enabled: false, configured: false });
    expect(config.musicbrainz).toMatchObject({ enabled: false, configured: false });
    expect(config.soundcloudManualLinksEnabled).toBe(true);
  });
});
