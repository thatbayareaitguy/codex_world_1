import { describe, expect, it } from "vitest";
import { publicCatalog } from "./public-catalog";

describe("Showcase public catalog fixture", () => {
  it("uses unique Showcase-owned public IDs and slugs", () => {
    const ids = [...publicCatalog.artists, ...publicCatalog.releases].map((item) => item.publicId);
    const slugs = [...publicCatalog.artists, ...publicCatalog.releases].map((item) => item.slug);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(ids.every((id) => /^(artist|release)_[a-z0-9_]+$/.test(id))).toBe(true);
  });

  it("contains only resolvable public artist references", () => {
    const artistSlugs = new Set(publicCatalog.artists.map((artist) => artist.slug));

    for (const release of publicCatalog.releases) {
      expect(release.artistSlugs.length).toBeGreaterThan(0);
      expect(release.artistSlugs.every((slug) => artistSlugs.has(slug))).toBe(true);
    }

    for (const artist of publicCatalog.artists) {
      expect(artist.relatedArtistSlugs.every((slug) => artistSlugs.has(slug))).toBe(true);
    }
  });

  it("keeps the publishing contract free of private operational fields", () => {
    const serialized = JSON.stringify(publicCatalog).toLowerCase();
    const forbiddenFields = [
      "credential",
      "scheduler",
      "quota",
      "playlist",
      "reviewstate",
      "databaseurl",
      "error_message",
    ];

    for (const field of forbiddenFields) expect(serialized).not.toContain(field);
    expect(publicCatalog.contractVersion).toBe("showcase-public-v0.1");
  });
});
