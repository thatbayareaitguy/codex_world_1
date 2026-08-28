import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { getGenreReviewDataset, saveArtistGenreReview } from "./genre-editorial-store";

const temporaryDirectories: string[] = [];
const privateDocumentSchema = z.object({ suggestions: z.record(z.string(), z.unknown()) });
const publicSafeDocumentSchema = z.object({
  assignments: z.array(z.object({ publicId: z.string(), genreSlugs: z.array(z.string()) })),
  contractVersion: z.string(),
  updatedAt: z.string().nullable(),
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function paths() {
  const directory = await mkdtemp(join(tmpdir(), "showcase-genre-review-"));
  temporaryDirectories.push(directory);
  return {
    confirmedGenresPath: join(directory, "confirmed.json"),
    privateReviewsPath: join(directory, "private.json"),
    now: () => new Date("2026-08-28T12:00:00.000Z"),
  };
}

describe("genre editorial store", () => {
  it("sorts unclassified artists first and persists suggestions only in private storage", async () => {
    const options = await paths();
    const dataset = await getGenreReviewDataset(options);
    expect(dataset.artists[0]?.genreSlugs).toEqual([]);
    expect(dataset.unclassifiedCount).toBeGreaterThan(0);
    expect(dataset.classifiedCount).toBeGreaterThan(0);

    const privateDocument = privateDocumentSchema.parse(
      JSON.parse(await readFile(options.privateReviewsPath, "utf8")) as unknown,
    );
    expect(Object.keys(privateDocument.suggestions)).toHaveLength(dataset.unclassifiedCount);
    await expect(readFile(options.confirmedGenresPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("saves only an authoritative public-safe assignment and updates the counts", async () => {
    const options = await paths();
    const before = await getGenreReviewDataset(options);
    const artist = before.artists.find((candidate) => candidate.genreSlugs.length === 0);
    expect(artist).toBeDefined();

    const after = await saveArtistGenreReview(
      { publicId: artist!.publicId, genreSlugs: ["dubstep", "riddim"] },
      options,
    );
    expect(after.classifiedCount).toBe(before.classifiedCount + 1);
    expect(after.unclassifiedCount).toBe(before.unclassifiedCount - 1);

    const publicSafeText = await readFile(options.confirmedGenresPath, "utf8");
    const publicSafeDocument = publicSafeDocumentSchema.parse(
      JSON.parse(publicSafeText) as unknown,
    );
    expect(publicSafeDocument.assignments).toEqual([
      { publicId: artist!.publicId, genreSlugs: ["dubstep", "riddim"] },
    ]);
    expect(publicSafeText).not.toContain("suggestion");
    expect(publicSafeText).not.toContain("evidenceSummary");
    expect(Object.keys(publicSafeDocument).sort()).toEqual([
      "assignments",
      "contractVersion",
      "updatedAt",
    ]);
  });
});
