import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  autoConfirmEligibleHighGenres,
  getDefaultConfirmedGenresPath,
  getGenreReviewDataset,
  saveArtistGenreReview,
  skipArtistGenreReview,
} from "./genre-editorial-store";
import { emptyGenreEvidenceDocument } from "./genre-evidence";
import { writeGenreEvidenceDocument } from "./genre-evidence-store";

describe("getDefaultConfirmedGenresPath", () => {
  it("resolves the committed Showcase contract independently of the process working directory", () => {
    expect(getDefaultConfirmedGenresPath().replaceAll("\\", "/")).toMatch(
      /\/apps\/showcase\/lib\/confirmed-artist-genres\.json$/,
    );
  });
});

const temporaryDirectories: string[] = [];
const privateDocumentSchema = z.object({ suggestions: z.record(z.string(), z.unknown()) });
const privateProvenanceSchema = z.object({
  confirmationOrigins: z.record(
    z.string(),
    z.object({ mode: z.enum(["manual", "automated"]), confirmedAt: z.string() }),
  ),
  skippedAtByArtistId: z.record(z.string(), z.string()),
});
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
    evidencePath: join(directory, "evidence.json"),
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
      { publicId: artist!.publicId, genreSlugs: ["bass-music", "dubstep", "riddim"] },
    ]);
    expect(publicSafeText).not.toContain("suggestion");
    expect(publicSafeText).not.toContain("evidenceSummary");
    expect(Object.keys(publicSafeDocument).sort()).toEqual([
      "assignments",
      "contractVersion",
      "updatedAt",
    ]);
  });

  it("auto-confirms only eligible HIGH evidence and stores provenance privately", async () => {
    const options = await paths();
    const before = await getGenreReviewDataset(options);
    const artist = before.artists.find((candidate) => candidate.genreSlugs.length === 0);
    expect(artist).toBeDefined();
    const evidence = emptyGenreEvidenceDocument();
    await writeGenreEvidenceDocument(
      {
        ...evidence,
        updatedAt: "2026-08-28T11:00:00.000Z",
        records: {
          [artist!.publicId]: {
            publicId: artist!.publicId,
            artistName: artist!.name,
            researchedAt: "2026-08-28T11:00:00.000Z",
            suggestion: {
              genreSlugs: ["riddim"],
              confidence: "high",
              evidenceSummary: "An official source and Discogs independently agree.",
              sources: [
                {
                  title: "Official artist biography",
                  url: "https://example.com/artist",
                  kind: "official-artist",
                },
                {
                  title: "Discogs release styles",
                  url: "https://www.discogs.com/search/",
                  kind: "discogs",
                  evidenceCount: 3,
                },
              ],
              conflicts: [],
              automationEligible: true,
              researchStatus: "researched",
            },
          },
        },
      },
      options.evidencePath,
    );

    const after = await autoConfirmEligibleHighGenres(options);
    expect(after.classifiedCount).toBe(before.classifiedCount + 1);
    const publicSafeText = await readFile(options.confirmedGenresPath, "utf8");
    expect(publicSafeText).toContain('"bass-music"');
    expect(publicSafeText).not.toContain("Discogs");
    expect(publicSafeText).not.toContain("evidenceSummary");
    const privateDocument = privateProvenanceSchema.parse(
      JSON.parse(await readFile(options.privateReviewsPath, "utf8")) as unknown,
    );
    expect(privateDocument.confirmationOrigins[artist!.publicId]?.mode).toBe("automated");
  });

  it("does not auto-confirm a manually decided or skipped artist", async () => {
    const options = await paths();
    const before = await getGenreReviewDataset(options);
    const [manualArtist, skippedArtist] = before.artists.filter(
      (candidate) => candidate.genreSlugs.length === 0,
    );
    expect(manualArtist).toBeDefined();
    expect(skippedArtist).toBeDefined();
    await saveArtistGenreReview({ publicId: manualArtist!.publicId, genreSlugs: [] }, options);
    await skipArtistGenreReview(skippedArtist!.publicId, options);
    const evidence = emptyGenreEvidenceDocument();
    const suggestion = {
      genreSlugs: ["tech-house" as const],
      confidence: "high" as const,
      evidenceSummary: "Strict independent corroboration.",
      sources: [
        {
          title: "Official artist biography",
          url: "https://example.com/artist",
          kind: "official-artist" as const,
        },
        {
          title: "Discogs release styles",
          url: "https://www.discogs.com/search/",
          kind: "discogs" as const,
          evidenceCount: 3,
        },
      ],
      conflicts: [],
      automationEligible: true,
      researchStatus: "researched" as const,
    };
    await writeGenreEvidenceDocument(
      {
        ...evidence,
        updatedAt: "2026-08-28T11:00:00.000Z",
        records: Object.fromEntries(
          [manualArtist!, skippedArtist!].map((candidate) => [
            candidate.publicId,
            {
              publicId: candidate.publicId,
              artistName: candidate.name,
              researchedAt: "2026-08-28T11:00:00.000Z",
              suggestion,
            },
          ]),
        ),
      },
      options.evidencePath,
    );
    const after = await autoConfirmEligibleHighGenres(options);
    expect(
      after.artists.find((artist) => artist.publicId === manualArtist!.publicId)?.genreSlugs,
    ).toEqual([]);
    expect(
      after.artists.find((artist) => artist.publicId === skippedArtist!.publicId)?.genreSlugs,
    ).toEqual([]);
  });
});
