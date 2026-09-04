import { normalizeText } from "./normalize";

export interface AppleIdentityCatalogRelease {
  appleReleaseId: string;
  artistIds: string[];
  artistName: string;
  artworkUrl?: string;
  copyright?: string;
  label?: string;
  releaseDate?: string;
  title: string;
  trackCount?: number;
}

export interface AppleIdentityCatalogSong {
  albumTitle?: string;
  appleSongId: string;
  artistIds: string[];
  artistName: string;
  artworkUrl?: string;
  releaseDate?: string;
  title: string;
}

export interface AppleIdentityCandidateCatalog {
  appleArtistId: string;
  artistName: string;
  artistUrl?: string;
  artworkUrl?: string;
  genres: string[];
  labels: string[];
  releases: AppleIdentityCatalogRelease[];
  resourceStatus: "invalid" | "unknown" | "valid";
  songs: AppleIdentityCatalogSong[];
  source: "apple_music_api" | "itunes_lookup";
}

export interface AppleIdentityCandidateRankingInput {
  catalog?: AppleIdentityCandidateCatalog;
  claimedByOtherCanonicalArtist?: boolean;
  comparisonCatalog?: AppleIdentityCandidateCatalog;
  exactIndependentLink?: "musicbrainz_url" | "wikidata_property";
  proposedAppleArtistId: string;
}

export interface AppleIdentityCandidateRanking {
  appleArtistId: string;
  autoConfirmEligible: boolean;
  contradictions: string[];
  eliminationSafe: boolean;
  rank: number;
  reasons: string[];
  score: number;
  titleOverlaps: AppleIdentityTitleOverlap[];
  signals: {
    activityScore: number;
    catalogScore: number;
    confirmedCollaboratorCount: number;
    genreScore: number;
    independentExactLink: boolean;
    titleOverlapScore: number;
  };
}

export interface AppleIdentityTitleOverlap {
  distinctive: boolean;
  leftTitle: string;
  rightTitle: string;
  weight: number;
}

export interface AppleIdentityRankingContext {
  confirmedAppleArtistIds: ReadonlySet<string>;
  genreFrequency: ReadonlyMap<string, number>;
  now: Date;
  truthSetSize: number;
}

export interface AppleIdentityCalibrationResult {
  autoConfirmations: number;
  falseConfirmations: number;
  groups: number;
  top1Accuracy: number;
  top1Correct: number;
  top3Accuracy: number;
  top3Correct: number;
  trueCandidatesEliminated: number;
}

export const appleIdentityAutoConfirmThreshold = 1;
export const appleIdentityMinimumWinningMargin = 0.2;

export function rankAppleIdentityCandidates(
  candidates: AppleIdentityCandidateRankingInput[],
  context: AppleIdentityRankingContext,
): AppleIdentityCandidateRanking[] {
  const scored = candidates.map((candidate) => scoreCandidate(candidate, context));
  scored.sort(
    (left, right) =>
      right.score - left.score || left.appleArtistId.localeCompare(right.appleArtistId),
  );
  return scored.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

export function calibrateAppleIdentityRankings(
  groups: Array<{ candidates: AppleIdentityCandidateRanking[]; trueAppleArtistId: string }>,
): AppleIdentityCalibrationResult {
  let top1Correct = 0;
  let top3Correct = 0;
  let autoConfirmations = 0;
  let falseConfirmations = 0;
  let trueCandidatesEliminated = 0;
  for (const group of groups) {
    if (group.candidates[0]?.appleArtistId === group.trueAppleArtistId) top1Correct += 1;
    if (group.candidates.slice(0, 3).some((row) => row.appleArtistId === group.trueAppleArtistId)) {
      top3Correct += 1;
    }
    const automatic = selectAppleIdentityAutoConfirmation(group.candidates);
    if (automatic) {
      autoConfirmations += 1;
      if (automatic.appleArtistId !== group.trueAppleArtistId) falseConfirmations += 1;
    }
    if (
      group.candidates.some(
        (row) => row.appleArtistId === group.trueAppleArtistId && row.eliminationSafe,
      )
    ) {
      trueCandidatesEliminated += 1;
    }
  }
  const count = groups.length;
  return {
    autoConfirmations,
    falseConfirmations,
    groups: count,
    top1Accuracy: count ? top1Correct / count : 0,
    top1Correct,
    top3Accuracy: count ? top3Correct / count : 0,
    top3Correct,
    trueCandidatesEliminated,
  };
}

export function selectAppleIdentityAutoConfirmation(
  candidates: AppleIdentityCandidateRanking[],
): AppleIdentityCandidateRanking | undefined {
  const [winner, runnerUp] = candidates;
  if (
    !winner?.autoConfirmEligible ||
    winner.contradictions.length > 0 ||
    winner.score < appleIdentityAutoConfirmThreshold ||
    winner.score - (runnerUp?.score ?? 0) < appleIdentityMinimumWinningMargin
  ) {
    return undefined;
  }
  return winner;
}

export function buildAppleIdentityGenreFrequency(
  catalogs: AppleIdentityCandidateCatalog[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const catalog of catalogs) {
    for (const genre of new Set(catalog.genres.map(normalizeText).filter(Boolean))) {
      counts.set(genre, (counts.get(genre) ?? 0) + 1);
    }
  }
  return counts;
}

function scoreCandidate(
  candidate: AppleIdentityCandidateRankingInput,
  context: AppleIdentityRankingContext,
): Omit<AppleIdentityCandidateRanking, "rank"> {
  const catalog = candidate.catalog;
  const contradictions: string[] = [];
  const reasons: string[] = [];
  if (candidate.claimedByOtherCanonicalArtist) {
    contradictions.push("Apple artist ID is already confirmed for another canonical artist.");
  }
  if (catalog?.resourceStatus === "invalid") {
    contradictions.push("Apple directly reported that the candidate artist resource is invalid.");
  }
  const independentExactLink = Boolean(candidate.exactIndependentLink);
  if (independentExactLink) {
    reasons.push(
      candidate.exactIndependentLink === "musicbrainz_url"
        ? "Confirmed MusicBrainz URL relationship supplies this exact Apple artist ID."
        : "The Wikidata item linked from MusicBrainz supplies this exact Apple artist ID.",
    );
  }

  const catalogScore = catalog
    ? Math.min(0.12, catalog.releases.length * 0.012 + catalog.songs.length * 0.006)
    : 0;
  if (catalogScore) reasons.push("Apple-family catalog activity supports review ranking only.");
  const activityScore = catalog ? recentActivityScore(catalog, context.now) : 0;
  if (activityScore)
    reasons.push("Recent Apple-family catalog activity supports review ranking only.");
  const normalizedGenres = new Set(catalog?.genres.map(normalizeText).filter(Boolean) ?? []);
  const genreHits = [...normalizedGenres].reduce(
    (total, genre) => total + (context.genreFrequency.get(genre) ?? 0),
    0,
  );
  const genreScore =
    context.truthSetSize > 0 ? Math.min(0.1, genreHits / context.truthSetSize / 5) : 0;
  if (genreScore)
    reasons.push("Genres resemble the confirmed Apple truth set; this is not identity proof.");
  const collaboratorIds = new Set(
    [
      ...(catalog?.releases.flatMap((release) => release.artistIds) ?? []),
      ...(catalog?.songs.flatMap((song) => song.artistIds) ?? []),
    ].filter(
      (artistId) =>
        artistId !== candidate.proposedAppleArtistId &&
        context.confirmedAppleArtistIds.has(artistId),
    ),
  );
  const confirmedCollaboratorCount = collaboratorIds.size;
  const collaborationScore = Math.min(0.15, confirmedCollaboratorCount * 0.04);
  if (collaborationScore) {
    reasons.push(
      `${confirmedCollaboratorCount} direct Apple co-credit${confirmedCollaboratorCount === 1 ? "" : "s"} connect to confirmed artists; this is supporting evidence only.`,
    );
  }

  const titleOverlaps =
    catalog && candidate.comparisonCatalog
      ? compareAppleIdentityCatalogTitles(catalog, candidate.comparisonCatalog)
      : [];
  const distinctiveOverlaps = titleOverlaps.filter((overlap) => overlap.distinctive).length;
  const titleOverlapScore = Math.min(
    0.18,
    titleOverlaps.reduce((total, overlap) => total + overlap.weight, 0),
  );
  if (titleOverlapScore) {
    reasons.push(
      `${titleOverlaps.length} Apple-family title overlap${titleOverlaps.length === 1 ? "" : "s"}, including ${distinctiveOverlaps} distinctive title${distinctiveOverlaps === 1 ? "" : "s"}, support review ranking only.`,
    );
  }

  const eliminationSafe = catalog?.resourceStatus === "invalid";
  const autoConfirmEligible = independentExactLink && contradictions.length === 0;
  const softScore = Math.min(
    0.79,
    (catalog?.resourceStatus === "valid" ? 0.35 : 0) +
      catalogScore +
      activityScore +
      genreScore +
      collaborationScore +
      titleOverlapScore,
  );
  const score = autoConfirmEligible ? 1 : softScore;
  if (!independentExactLink) {
    reasons.push(
      "Automatic confirmation rejected: available signals are Apple-only ranking evidence, not an exact independent identity link.",
    );
  } else if (contradictions.length) {
    reasons.push("Automatic confirmation rejected because contradictory identity evidence exists.");
  }
  if (!catalog) reasons.push("No reusable Apple-family catalog summary has been fetched.");
  return {
    appleArtistId: candidate.proposedAppleArtistId,
    autoConfirmEligible,
    contradictions,
    eliminationSafe,
    reasons,
    score: Math.round(score * 1_000) / 1_000,
    titleOverlaps,
    signals: {
      activityScore,
      catalogScore,
      confirmedCollaboratorCount,
      genreScore,
      independentExactLink,
      titleOverlapScore,
    },
  };
}

export function compareAppleIdentityCatalogTitles(
  left: AppleIdentityCandidateCatalog,
  right: AppleIdentityCandidateCatalog,
): AppleIdentityTitleOverlap[] {
  const rightTitles = new Map<string, string>();
  for (const title of catalogTitles(right))
    rightTitles.set(normalizeAppleCatalogTitle(title), title);
  const overlaps: AppleIdentityTitleOverlap[] = [];
  const seen = new Set<string>();
  for (const leftTitle of catalogTitles(left)) {
    const normalized = normalizeAppleCatalogTitle(leftTitle);
    const rightTitle = rightTitles.get(normalized);
    if (!normalized || !rightTitle || seen.has(normalized)) continue;
    seen.add(normalized);
    const distinctive = !isGenericAppleCatalogTitle(normalized);
    overlaps.push({
      distinctive,
      leftTitle,
      rightTitle,
      weight: distinctive ? 0.06 : 0.01,
    });
  }
  return overlaps.sort(
    (leftOverlap, rightOverlap) =>
      Number(rightOverlap.distinctive) - Number(leftOverlap.distinctive) ||
      leftOverlap.leftTitle.localeCompare(rightOverlap.leftTitle),
  );
}

export function normalizeAppleCatalogTitle(value: string): string {
  return normalizeText(value)
    .replace(/\b(feat|featuring|ft)\b/g, " feat ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isGenericAppleCatalogTitle(normalizedTitle: string): boolean {
  const compact = normalizedTitle.replace(/[^a-z0-9]/g, "");
  return (
    compact.length < 5 ||
    /^(intro|outro|remix|live|track\d+|untitled|demo|love|home|stay|alone|forever)$/.test(compact)
  );
}

function catalogTitles(catalog: AppleIdentityCandidateCatalog): string[] {
  return [
    ...catalog.releases.map((release) => release.title),
    ...catalog.songs.map((song) => song.title),
  ];
}

function recentActivityScore(catalog: AppleIdentityCandidateCatalog, now: Date): number {
  const dates = [...catalog.releases, ...catalog.songs]
    .map((item) => item.releaseDate)
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  const latest = dates.length ? Math.max(...dates) : 0;
  if (!latest) return 0;
  const ageDays = Math.max(0, (now.getTime() - latest) / 86_400_000);
  if (ageDays <= 730) return 0.1;
  if (ageDays <= 1_825) return 0.05;
  return 0;
}
