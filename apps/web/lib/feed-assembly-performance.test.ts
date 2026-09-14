import { describe, expect, it } from "vitest";

describe("feed assembly lookup scaling", () => {
  it.each([150, 1_000, 3_000])(
    "produces equivalent output with indexed lookups for %d rows",
    (size) => {
      const feed = Array.from({ length: size }, (_, index) => ({
        feedId: index,
        trackId: size - index - 1,
      }));
      const tracks = Array.from({ length: size }, (_, id) => ({ id, title: `Track ${id}` }));
      const evidence = Array.from({ length: size }, (_, trackId) => ({
        href: `https://example.test/evidence/${trackId}`,
        trackId,
      }));

      const naiveStartedAt = performance.now();
      const naive = feed.map((row) => ({
        ...row,
        evidence: evidence.filter((item) => item.trackId === row.trackId),
        title: tracks.find((track) => track.id === row.trackId)!.title,
      }));
      const naiveMs = performance.now() - naiveStartedAt;

      const indexedStartedAt = performance.now();
      const trackById = new Map(tracks.map((track) => [track.id, track]));
      const evidenceByTrack = new Map<number, typeof evidence>();
      for (const item of evidence) {
        evidenceByTrack.set(item.trackId, [...(evidenceByTrack.get(item.trackId) ?? []), item]);
      }
      const indexed = feed.map((row) => ({
        ...row,
        evidence: evidenceByTrack.get(row.trackId) ?? [],
        title: trackById.get(row.trackId)!.title,
      }));
      const indexedMs = performance.now() - indexedStartedAt;

      console.info(
        JSON.stringify({
          diagnostic: "feed_assembly_lookup",
          indexedMs: Number(indexedMs.toFixed(3)),
          naiveMs: Number(naiveMs.toFixed(3)),
          size,
        }),
      );
      expect(indexed).toEqual(naive);
      if (size === 3_000) expect(indexedMs).toBeLessThan(naiveMs);
    },
  );
});
