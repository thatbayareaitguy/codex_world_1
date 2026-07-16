import { describe, expect, it, vi } from "vitest";
import {
  MusicBrainzClient,
  MusicBrainzProvider,
  MusicBrainzRateGate,
  classifyMusicBrainzRelease,
  scoreMusicBrainzArtist,
} from "./musicbrainz";

const artistMbid = "11111111-1111-4111-8111-111111111111";
const releaseMbid = "22222222-2222-4222-8222-222222222222";
const releaseGroupMbid = "33333333-3333-4333-8333-333333333333";
const trackMbid = "44444444-4444-4444-8444-444444444444";
const recordingMbid = "55555555-5555-4555-8555-555555555555";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const emptyReleases = {
  "release-count": 0,
  "release-offset": 0,
  releases: [],
};

describe("MusicBrainzRateGate", () => {
  it("serializes requests at one request per second", async () => {
    let now = 0;
    const waits: number[] = [];
    const gate = new MusicBrainzRateGate(
      1_000,
      () => now,
      (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
        return Promise.resolve();
      },
    );

    await Promise.all([
      gate.schedule(() => Promise.resolve("first")),
      gate.schedule(() => Promise.resolve("second")),
    ]);
    expect(waits).toEqual([1_000]);
  });
});

describe("MusicBrainzClient", () => {
  it("retries 503 responses without parallel requests", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse(emptyReleases));
    const sleep = vi.fn(() => Promise.resolve());
    const client = new MusicBrainzClient({
      contactEmail: "owner@example.test",
      fetcher,
      gate: new MusicBrainzRateGate(0),
      sleep,
    });

    await expect(client.browseReleases(artistMbid, "artist")).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
  });
});

describe("MusicBrainz matching and discovery", () => {
  it("scores exact aliases conservatively and classifies preserved versions", () => {
    const score = scoreMusicBrainzArtist("Night Index", ["Night Index Ensemble"], {
      aliases: [{ name: "Night Index Ensemble" }],
      disambiguation: "Los Angeles electronic group",
      id: artistMbid,
      name: "Night Index",
      score: 96,
      "sort-name": "Night Index",
    });

    expect(score.confidence).toBeGreaterThan(0.9);
    expect(classifyMusicBrainzRelease("Album", ["Live"])).toBe("live");
    expect(classifyMusicBrainzRelease("Album", ["Remix"])).toBe("remix");
  });

  it("creates future track-level appearance candidates with evidence", async () => {
    const appearance = {
      "artist-credit": [{ artist: { id: artistMbid, name: "Night Index" }, name: "Night Index" }],
      barcode: "123456789012",
      country: "US",
      date: "2030-08",
      id: releaseMbid,
      media: [
        {
          position: 1,
          "track-count": 1,
          tracks: [
            {
              "artist-credit": [
                {
                  artist: { id: "66666666-6666-4666-8666-666666666666", name: "Primary Artist" },
                  joinphrase: " feat. ",
                  name: "Primary Artist",
                },
                { artist: { id: artistMbid, name: "Night Index" }, name: "Night Index" },
              ],
              id: trackMbid,
              length: 201000,
              number: "1",
              position: 1,
              recording: {
                id: recordingMbid,
                isrcs: ["USTEST203001"],
                length: 201000,
                title: "Future Signal",
              },
              title: "Future Signal",
            },
          ],
        },
      ],
      "release-group": {
        "artist-credit": [],
        "first-release-date": "2030-08",
        id: releaseGroupMbid,
        "primary-type": "Single",
        "secondary-types": [],
        title: "Future Signal",
      },
      status: "Official",
      title: "Future Signal",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(emptyReleases))
      .mockResolvedValueOnce(
        jsonResponse({ "release-count": 1, "release-offset": 0, releases: [appearance] }),
      );
    const client = new MusicBrainzClient({
      contactEmail: "owner@example.test",
      fetcher,
      gate: new MusicBrainzRateGate(0),
    });
    const provider = new MusicBrainzProvider(
      client,
      [{ aliases: [], artistId: "canonical-artist", mbid: artistMbid, name: "Night Index" }],
      () => new Date("2029-01-01T00:00:00Z"),
    );

    const result = await provider.scan({ filter: {} });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      isUpcoming: true,
      releaseDate: "2030-08-01",
      releaseDatePrecision: "month",
      releaseType: "feature",
      musicbrainzRecordingId: recordingMbid,
    });
  });
});
