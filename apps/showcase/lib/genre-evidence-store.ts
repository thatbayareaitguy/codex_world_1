import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  combineGenreEvidence,
  emptyGenreEvidenceDocument,
  genreEvidenceDocumentSchema,
  researchDiscogsGenres,
  type GenreEvidenceDocument,
} from "./genre-evidence";
import { getCuratedGenreSuggestion } from "./genre-suggestions";
import type { PublicArtist } from "./public-catalog";

export function getGenreEvidencePath(): string {
  const localDataRoot = process.env.LOCALAPPDATA;
  if (localDataRoot === undefined || localDataRoot.trim() === "") {
    return resolve(process.cwd(), ".app-runtime", "artist-genre-evidence.json");
  }
  return (
    process.env.SHOWCASE_GENRE_EVIDENCE_PATH ??
    resolve(localDataRoot, "ShowcasePublicSite", "editorial", "artist-genre-evidence.json")
  );
}

export async function readGenreEvidenceDocument(
  path = getGenreEvidencePath(),
): Promise<GenreEvidenceDocument> {
  try {
    return genreEvidenceDocumentSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyGenreEvidenceDocument();
    throw error;
  }
}

export async function writeGenreEvidenceDocument(
  document: GenreEvidenceDocument,
  path = getGenreEvidencePath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

export interface GenreResearchProgress {
  readonly completed: number;
  readonly total: number;
  readonly artistName: string;
  readonly confidence: "high" | "medium" | "low";
  readonly sourceCount: number;
}

export interface ResearchUnclassifiedGenreOptions {
  readonly artists: readonly PublicArtist[];
  readonly fetcher?: typeof fetch;
  readonly limit?: number;
  readonly refresh?: boolean;
  readonly delayMs?: number;
  readonly now?: () => Date;
  readonly evidencePath?: string;
  readonly onProgress?: (progress: GenreResearchProgress) => void;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

export async function researchUnclassifiedGenres(
  options: ResearchUnclassifiedGenreOptions,
): Promise<GenreEvidenceDocument> {
  const evidencePath = options.evidencePath ?? getGenreEvidencePath();
  let document = await readGenreEvidenceDocument(evidencePath);
  const unclassified = options.artists
    .filter((artist) => artist.genreSlugs.length === 0)
    .filter((artist) => options.refresh === true || document.records[artist.publicId] === undefined)
    .slice(0, options.limit ?? Number.POSITIVE_INFINITY);

  for (const [index, artist] of unclassified.entries()) {
    let suggestion;
    try {
      const discogs = await researchDiscogsGenres(artist, options.fetcher);
      suggestion = combineGenreEvidence(getCuratedGenreSuggestion(artist), discogs);
    } catch {
      const curated = getCuratedGenreSuggestion(artist);
      suggestion =
        curated === undefined
          ? {
              genreSlugs: ["other-electronic" as const],
              confidence: "low" as const,
              evidenceSummary:
                "The automated Discogs request did not complete and no curated public source is attached. No classification is recommended.",
              sources: [],
              conflicts: [],
              automationEligible: false,
              researchStatus: "partial" as const,
            }
          : {
              ...curated,
              confidence: "medium" as const,
              evidenceSummary: `${curated.evidenceSummary} Automated Discogs corroboration was unavailable, so editorial confirmation remains required.`,
              automationEligible: false,
              researchStatus: "partial" as const,
            };
    }
    const researchedAt = (options.now ?? (() => new Date()))().toISOString();
    document = {
      ...document,
      updatedAt: researchedAt,
      records: {
        ...document.records,
        [artist.publicId]: {
          publicId: artist.publicId,
          artistName: artist.name,
          researchedAt,
          suggestion,
        },
      },
    };
    await writeGenreEvidenceDocument(document, evidencePath);
    options.onProgress?.({
      completed: index + 1,
      total: unclassified.length,
      artistName: artist.name,
      confidence: suggestion.confidence,
      sourceCount: suggestion.sources.length,
    });
    if (index < unclassified.length - 1) await wait(options.delayMs ?? 2_600);
  }

  return document;
}

export function summarizeGenreEvidence(document: GenreEvidenceDocument): {
  readonly researched: number;
  readonly confidence: Readonly<Record<"high" | "medium" | "low", number>>;
  readonly eligibleHigh: number;
  readonly sourceCoverage: Readonly<Record<string, number>>;
} {
  const records = Object.values(document.records);
  const confidence = { high: 0, medium: 0, low: 0 };
  const sourceCoverage: Record<string, number> = {};
  let eligibleHigh = 0;
  for (const record of records) {
    confidence[record.suggestion.confidence] += 1;
    if (record.suggestion.automationEligible === true) eligibleHigh += 1;
    for (const kind of new Set(
      record.suggestion.sources.map((source) => source.kind ?? "legacy"),
    )) {
      sourceCoverage[kind] = (sourceCoverage[kind] ?? 0) + 1;
    }
  }
  return { researched: records.length, confidence, eligibleHigh, sourceCoverage };
}
