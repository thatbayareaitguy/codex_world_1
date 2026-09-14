import { beforeEach, describe, expect, it, vi } from "vitest";

const { configuration } = vi.hoisted(() => ({
  configuration: { musicbrainz: { enabled: false } },
}));

vi.mock("@radar/providers", () => ({
  loadProviderConfiguration: vi.fn(() => configuration),
}));

import { musicBrainzDisabledMessage, musicBrainzDisabledResponse } from "./musicbrainz-feature";

describe("MusicBrainz feature boundary", () => {
  beforeEach(() => {
    configuration.musicbrainz.enabled = false;
  });

  it("returns a stable forbidden response while the provider is disabled", async () => {
    const response = musicBrainzDisabledResponse();

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({ error: musicBrainzDisabledMessage });
  });

  it("preserves the explicitly enabled advanced path", () => {
    configuration.musicbrainz.enabled = true;

    expect(musicBrainzDisabledResponse()).toBeNull();
  });
});
