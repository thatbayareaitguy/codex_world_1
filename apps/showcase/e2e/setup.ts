import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export default async function setupShowcaseE2e(): Promise<void> {
  const runtimeDirectory = resolve("apps", "showcase", ".app-runtime");
  const evidencePath = resolve(runtimeDirectory, "e2e-genre-evidence.json");
  await Promise.all([
    rm(resolve(runtimeDirectory, "e2e-confirmed-genres.json"), { force: true }),
    rm(resolve(runtimeDirectory, "e2e-genre-reviews.json"), { force: true }),
    rm(evidencePath, { force: true }),
  ]);
  const catalog = JSON.parse(
    await readFile(resolve("apps", "showcase", "lib", "generated-public-catalog.json"), "utf8"),
  ) as { artists: { publicId: string; name: string }[] };
  const artist = catalog.artists.find((candidate) => candidate.name === "3LAU");
  if (artist === undefined) throw new Error("3LAU is missing from the Showcase fixture.");
  await writeFile(
    evidencePath,
    `${JSON.stringify(
      {
        contractVersion: "showcase-private-genre-evidence-v1",
        updatedAt: "2026-08-30T12:00:00.000Z",
        records: {
          [artist.publicId]: {
            publicId: artist.publicId,
            artistName: artist.name,
            researchedAt: "2026-08-30T12:00:00.000Z",
            suggestion: {
              genreSlugs: ["house", "progressive-house"],
              confidence: "high",
              evidenceSummary:
                "The synthetic end-to-end fixture has two independently agreeing source records.",
              sources: [
                {
                  title: "Test official source",
                  url: "https://example.com/test-official-source",
                  kind: "official-artist",
                  terms: ["progressive house"],
                  normalizedGenreSlugs: ["house", "progressive-house"],
                  evidenceCount: 1,
                },
                {
                  title: "Test release-style source",
                  url: "https://example.com/test-release-style-source",
                  kind: "discogs",
                  terms: ["Progressive House"],
                  normalizedGenreSlugs: ["house", "progressive-house"],
                  evidenceCount: 8,
                },
              ],
              conflicts: [],
              automationEligible: true,
              researchStatus: "researched",
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
