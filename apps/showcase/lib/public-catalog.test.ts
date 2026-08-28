import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { publicCatalog } from "./public-catalog";
import { showcaseGenreTaxonomy } from "./genre-taxonomy";

const releaseRequiredKeys = [
  "artistCredits",
  "artworkTone",
  "firstDiscoveredDate",
  "genreSlugs",
  "links",
  "publicId",
  "releaseDate",
  "slug",
  "status",
  "title",
  "tracks",
  "type",
];

describe("Showcase public catalog", () => {
  it("uses unique Showcase-owned public IDs and slugs", () => {
    const ids = [...publicCatalog.artists, ...publicCatalog.releases].map((item) => item.publicId);
    const slugs = [...publicCatalog.artists, ...publicCatalog.releases].map((item) => item.slug);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(ids.every((id) => /^(artist|release)_[a-f0-9]{20}$/.test(id))).toBe(true);
  });

  it("resolves every linked release credit to a real published artist page", () => {
    const artistSlugs = new Set(publicCatalog.artists.map((artist) => artist.slug));
    for (const release of publicCatalog.releases) {
      expect(release.artistCredits.length).toBeGreaterThan(0);
      expect(release.artistCredits[0]?.artistSlug).toBeDefined();
      for (const credit of release.artistCredits) {
        expect(credit.name.trim()).not.toBe("");
        if (credit.artistSlug !== undefined) expect(artistSlugs.has(credit.artistSlug)).toBe(true);
      }
    }
  });

  it("loads only strict v2 public artists, taxonomy, and Apple-origin releases", () => {
    expect(publicCatalog.contractVersion).toBe("showcase-public-v2");
    expect(publicCatalog.genres).toEqual(showcaseGenreTaxonomy);
    const genreSlugs = new Set(publicCatalog.genres.map((genre) => genre.slug));
    expect(genreSlugs.size).toBe(publicCatalog.genres.length);
    for (const artist of publicCatalog.artists) {
      const expectedKeys = [
        "artworkTone",
        "genreSlugs",
        "links",
        "name",
        "publicId",
        "slug",
        ...(artist.labelAssociations === undefined ? [] : ["labelAssociations"]),
      ].sort();
      expect(Object.keys(artist).sort()).toEqual(expectedKeys);
      expect(artist.genreSlugs.every((slug) => genreSlugs.has(slug))).toBe(true);
      const apple = new URL(artist.links.appleMusic);
      expect(apple.hostname).toBe("music.apple.com");
      expect(apple.pathname).toContain("/artist/");
      if (artist.links.spotify !== undefined) {
        const spotify = new URL(artist.links.spotify);
        expect(spotify.hostname).toBe("open.spotify.com");
        expect(spotify.pathname).toContain("/artist/");
      }
    }
    for (const release of publicCatalog.releases) {
      const expectedKeys = [
        ...releaseRequiredKeys,
        ...(release.label === undefined ? [] : ["label"]),
      ].sort();
      expect(Object.keys(release).sort()).toEqual(expectedKeys);
      expect(release.genreSlugs.every((slug) => genreSlugs.has(slug))).toBe(true);
      expect(release.status === "released" || release.status === "upcoming").toBe(true);
      const apple = new URL(release.links.appleMusic);
      expect(apple.hostname).toBe("music.apple.com");
      expect(apple.pathname).toContain("/album/");
      if (release.links.spotify !== undefined) {
        const spotify = new URL(release.links.spotify);
        expect(spotify.hostname).toBe("open.spotify.com");
        expect(spotify.pathname).toContain("/album/");
      }
    }
  });

  it("keeps the entire generated contract free of private operational fields", () => {
    const serialized = JSON.stringify(publicCatalog).toLowerCase();
    const forbiddenFields = [
      "credential",
      "scheduler",
      "quota",
      "cooldown",
      "playlistexport",
      "reviewinternal",
      "databaseid",
      "identityevidence",
      "providererror",
      "rawpayload",
      "matchreason",
      "canonicalartistid",
      "providerartistid",
      "providerreleaseid",
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
