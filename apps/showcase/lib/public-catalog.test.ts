import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { publicCatalog } from "./public-catalog";

const releaseKeys = [
  "artistName",
  "artworkTone",
  "firstDiscoveredDate",
  "genres",
  "links",
  "publicId",
  "releaseDate",
  "slug",
  "status",
  "title",
  "tracks",
  "type",
].sort();

describe("Showcase public catalog", () => {
  it("uses unique Showcase-owned public IDs and slugs", () => {
    const ids = [...publicCatalog.artists, ...publicCatalog.releases].map((item) => item.publicId);
    const slugs = [...publicCatalog.artists, ...publicCatalog.releases].map((item) => item.slug);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(ids.every((id) => /^(artist|release)_[a-z0-9_]+$/.test(id))).toBe(true);
  });

  it("keeps fixture artist relationships resolvable while releases carry real artist names", () => {
    const artistSlugs = new Set(publicCatalog.artists.map((artist) => artist.slug));
    for (const artist of publicCatalog.artists) {
      expect(artist.relatedArtistSlugs.every((slug) => artistSlugs.has(slug))).toBe(true);
    }
    for (const release of publicCatalog.releases) expect(release.artistName.trim()).not.toBe("");
  });

  it("loads only strict v1 Apple-origin release records", () => {
    expect(publicCatalog.contractVersion).toBe("showcase-public-v1");
    for (const release of publicCatalog.releases) {
      expect(Object.keys(release).sort()).toEqual(releaseKeys);
      expect(release.status === "released" || release.status === "upcoming").toBe(true);
      expect(new URL(release.links.appleMusic).hostname).toBe("music.apple.com");
      if (release.links.spotify !== undefined) {
        const spotify = new URL(release.links.spotify);
        expect(spotify.hostname).toBe("open.spotify.com");
        expect(spotify.pathname.startsWith("/album/")).toBe(true);
      }
    }
  });

  it("keeps the generated release contract free of private operational fields", () => {
    const serialized = JSON.stringify(publicCatalog.releases).toLowerCase();
    const forbiddenFields = [
      "credential",
      "scheduler",
      "quota",
      "cooldown",
      "playlist",
      "review",
      "database",
      "identityevidence",
      "providererror",
      "rawpayload",
      "matchreason",
    ];

    for (const field of forbiddenFields) expect(serialized).not.toContain(field);
  });

  it("has no scanner database or provider API runtime dependency", async () => {
    const sourceFiles = await listSourceFiles(join(process.cwd(), "apps", "showcase"));
    const source = (
      await Promise.all(sourceFiles.map(async (path) => await readFile(path, "utf8")))
    ).join("\n");

    expect(source).not.toMatch(/@radar\/(?:db|providers)/);
    expect(source).not.toContain("DATABASE_URL");
    expect(source).not.toContain("api.music.apple.com");
    expect(source).not.toContain("api.spotify.com");
    expect(source).not.toMatch(/from ["']postgres["']/);
  });
});

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries
      .filter(
        (entry) =>
          !entry.name.startsWith(".next") && entry.name !== "node_modules" && entry.name !== "e2e",
      )
      .map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return await listSourceFiles(path);
        return [".ts", ".tsx"].includes(extname(entry.name)) && !entry.name.endsWith(".test.ts")
          ? [path]
          : [];
      }),
  );
  return paths.flat();
}
