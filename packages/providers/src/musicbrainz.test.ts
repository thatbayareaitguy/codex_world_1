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
const emptyReleaseGroups = {
  "release-group-count": 0,
  "release-group-offset": 0,
  "release-groups": [],
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

  it("uses the configured application identity in its User-Agent", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(emptyReleaseGroups));
    const client = new MusicBrainzClient({
      contactEmail: "owner@example.test",
      fetcher,
      gate: new MusicBrainzRateGate(0),
      packageVersion: "1.2.3",
    });
    await client.browseReleaseGroups(artistMbid);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      "User-Agent": "TSNewMusicRadar/1.2.3 (owner@example.test)",
    });
  });

  it("supports a bounded single-page release-group lookup", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(emptyReleaseGroups));
    const client = new MusicBrainzClient({
      contactEmail: "owner@example.test",
      fetcher,
      gate: new MusicBrainzRateGate(0),
    });
    await expect(client.browseReleaseGroupsFirstPage(artistMbid)).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const request = fetcher.mock.calls[0]?.[0];
    const requestUrl =
      typeof request === "string" ? request : request instanceof URL ? request.href : request?.url;
    expect(requestUrl).toContain("limit=100&offset=0");
  });

  it("does not retry invalid MusicBrainz payloads", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ releases: [] }));
    const client = new MusicBrainzClient({
      contactEmail: "owner@example.test",
      fetcher,
      gate: new MusicBrainzRateGate(0),
    });
    await expect(client.browseReleases(artistMbid, "artist")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("accepts nullable fields returned by real artist search responses", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        artists: [
          {
            aliases: [{ name: "Yussi", primary: null }],
            country: null,
            id: artistMbid,
            name: "YUSSI",
            score: 100,
            "sort-name": "YUSSI",
          },
        ],
        count: 1,
        offset: 0,
      }),
    );
    const client = new MusicBrainzClient({
      contactEmail: "owner@example.test",
      fetcher,
      gate: new MusicBrainzRateGate(0),
    });
    await expect(client.searchArtists("YUSSI")).resolves.toHaveLength(1);
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
    expect(classifyMusicBrainzRelease("Album", ["Compilation"])).toBe("compilation");
    expect(classifyMusicBrainzRelease("Album", ["DJ-mix"])).toBe("dj_mix");
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
      .mockResolvedValueOnce(jsonResponse(emptyReleaseGroups))
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

  it("persists provider stages incrementally and counts an artist only after appearances", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(emptyReleaseGroups))
      .mockResolvedValueOnce(jsonResponse(emptyReleases))
      .mockResolvedValueOnce(jsonResponse(emptyReleases));
    const provider = new MusicBrainzProvider(
      new MusicBrainzClient({
        contactEmail: "owner@example.test",
        fetcher,
        gate: new MusicBrainzRateGate(0),
      }),
      [{ aliases: [], artistId: "canonical-artist", mbid: artistMbid, name: "Night Index" }],
    );
    const batches: Array<{ completedUnits: number; stage: string }> = [];
    await provider.scan({
      filter: {},
      onBatch: (batch) => {
        if (!batch.stage) throw new Error("Expected a MusicBrainz stage");
        batches.push({ completedUnits: batch.completedUnits, stage: batch.stage });
        return Promise.resolve();
      },
    });
    expect(batches).toEqual([
      { completedUnits: 0, stage: "release_groups" },
      { completedUnits: 0, stage: "primary_releases" },
      { completedUnits: 1, stage: "track_appearances" },
    ]);
  });

  it("stops safely before the next discovery stage when cancelled", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(emptyReleaseGroups));
    const provider = new MusicBrainzProvider(
      new MusicBrainzClient({
        contactEmail: "owner@example.test",
        fetcher,
        gate: new MusicBrainzRateGate(0),
      }),
      [{ aliases: [], artistId: "canonical-artist", mbid: artistMbid, name: "Night Index" }],
    );
    await expect(
      provider.scan({
        filter: {},
        onBatch: () => {
          controller.abort(new Error("cancelled"));
          return Promise.resolve();
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
