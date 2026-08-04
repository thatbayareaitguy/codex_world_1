import { extractVersion, normalizeText } from "./normalize";

export type ItunesMappingStatus =
  "exact_confirmed" | "evidence_confirmed" | "ambiguous" | "no_match" | "rejected";

export interface ItunesArtistCandidate {
  artistId: string;
  artistName: string;
  primaryGenreName?: string;
  viewUrl?: string;
}

export interface ItunesMappingDecision {
  ambiguityReason?: string;
  candidateEvidence?: ItunesIdentityCandidateEvidence[];
  confidence: number;
  evidence: string[];
  reason: string;
  selected?: ItunesArtistCandidate;
  status: ItunesMappingStatus;
}

export interface ItunesCollectionCandidate {
  artistId?: string;
  artistName?: string;
  collectionArtistId?: string;
  collectionArtistName?: string;
  collectionId: string;
  collectionName: string;
  explicitness?: string;
  primaryGenreName?: string;
  releaseDate: string;
  source: "album_lookup" | "song_lookup" | "both";
  trackCount?: number;
  viewUrl?: string;
}

export interface ItunesTrackCandidate {
  artistId?: string;
  artistName: string;
  collectionArtistId?: string;
  collectionArtistName?: string;
  collectionId?: string;
  collectionName?: string;
  discCount?: number;
  discNumber?: number;
  explicitness?: string;
  releaseDate: string;
  trackCount?: number;
  trackId: string;
  trackName: string;
  trackNumber?: number;
  trackTimeMillis?: number;
  viewUrl?: string;
}

export interface SpotifyGroundTruthRelease {
  canonicalReleaseId: string;
  evidenceCutoff?: string;
  evidenceSource?: string;
  normalizedTitle: string;
  releaseDate: string;
  releaseType: string;
  spotifyReleaseId: string;
  title: string;
  trackCount?: number;
  tracks?: Array<{
    durationMs?: number;
    isrc?: string;
    normalizedTitle: string;
    releaseDate?: string;
    title: string;
  }>;
  upc?: string;
  version?: string;
}

export type ItunesComparisonClassification =
  | "exact_match"
  | "strong_probable_match"
  | "ambiguous_match"
  | "invalid_match"
  | "apple_only_or_spotify_missing"
  | "spotify_ground_truth_missed_by_itunes"
  | "identity_mapping_failure";

export interface ItunesReleaseComparison {
  appleCollectionId?: string;
  classification: ItunesComparisonClassification;
  dateDifferenceDays?: number;
  reasons: string[];
  spotifyReleaseId?: string;
  trackCountAgreement?: boolean;
}

export interface ItunesIdentityCandidateCatalog {
  candidate: ItunesArtistCandidate;
  collections: ItunesCollectionCandidate[];
  tracks: ItunesTrackCandidate[];
}

export interface ItunesIdentityCandidateEvidence {
  artistId: string;
  confidence: number;
  conflictingReleases: string[];
  creditCompatible: boolean;
  decision: "confirm" | "ambiguous" | "reject" | "not_examined";
  decisionReason: string;
  evidenceExamined: string[];
  exactReleaseTitleMatches: number;
  matchedReleases: string[];
  score: number;
  trackTitleOverlap: number;
}

export interface ItunesReleasePairEvaluation {
  apple: ItunesCollectionCandidate;
  classification: "exact_match" | "strong_probable_match" | "ambiguous_match" | "invalid_match";
  dateDifferenceDays: number;
  reasons: string[];
  trackCountAgreement?: boolean;
}

export function decideItunesArtistMapping(input: {
  aliases: string[];
  candidates: ItunesArtistCandidate[];
  canonicalName: string;
}): ItunesMappingDecision {
  const canonical = normalizeArtistIdentity(input.canonicalName);
  const exact = input.candidates.filter(
    (candidate) => normalizeArtistIdentity(candidate.artistName) === canonical,
  );
  if (exact.length === 1) {
    return {
      confidence: 1,
      evidence: ["one exact normalized canonical-name match"],
      reason: "Unique exact normalized artist-name match.",
      selected: exact[0]!,
      status: "exact_confirmed",
    };
  }
  if (exact.length > 1) {
    return {
      ambiguityReason: "Multiple candidates share the exact normalized canonical name.",
      confidence: 0,
      evidence: exact.map((candidate) => `competing:${candidate.artistId}`),
      reason: "Exact name is not unique.",
      status: "ambiguous",
    };
  }
  const aliases = new Set(input.aliases.map(normalizeArtistIdentity).filter(Boolean));
  const aliasMatches = input.candidates.filter((candidate) =>
    aliases.has(normalizeArtistIdentity(candidate.artistName)),
  );
  if (aliasMatches.length === 1) {
    return {
      confidence: 0.95,
      evidence: [`stored_alias:${aliasMatches[0]!.artistName}`],
      reason: "One candidate exactly matches a stored artist alias.",
      selected: aliasMatches[0]!,
      status: "evidence_confirmed",
    };
  }
  if (aliasMatches.length > 1) {
    return {
      ambiguityReason: "Multiple candidates match stored aliases.",
      confidence: 0,
      evidence: aliasMatches.map((candidate) => `competing_alias:${candidate.artistId}`),
      reason: "Alias evidence is not unique.",
      status: "ambiguous",
    };
  }
  if (input.candidates.length === 0) {
    return {
      confidence: 0,
      evidence: [],
      reason: "Artist search returned no candidates.",
      status: "no_match",
    };
  }
  return {
    ambiguityReason: "Search returned candidates but none had an exact canonical or alias match.",
    confidence: 0,
    evidence: [],
    reason: "Similar spelling, genre, rank, and partial words are insufficient.",
    status: "ambiguous",
  };
}

export function resolveItunesArtistFromCatalogEvidence(input: {
  aliases: string[];
  candidates: ItunesIdentityCandidateCatalog[];
  canonicalName: string;
  groundTruth: SpotifyGroundTruthRelease[];
}): ItunesMappingDecision {
  const canonical = normalizeArtistIdentity(input.canonicalName);
  const aliases = new Set(input.aliases.map(normalizeArtistIdentity).filter(Boolean));
  const groundTruthTrackTitles = new Set(
    input.groundTruth.flatMap((release) =>
      (release.tracks ?? []).map((track) => normalizeText(track.normalizedTitle || track.title)),
    ),
  );
  const candidateEvidence = input.candidates.map((catalog): ItunesIdentityCandidateEvidence => {
    const normalizedCandidate = normalizeArtistIdentity(catalog.candidate.artistName);
    const nameCompatible = normalizedCandidate === canonical || aliases.has(normalizedCandidate);
    const comparisons = compareItunesToSpotify(input.groundTruth, catalog.collections).filter(
      (comparison) => comparison.spotifyReleaseId,
    );
    const matched = comparisons.filter((comparison) =>
      ["exact_match", "strong_probable_match"].includes(comparison.classification),
    );
    const conflicting = comparisons.filter((comparison) =>
      ["invalid_match"].includes(comparison.classification),
    );
    const exactReleaseTitleMatches = matched.filter((comparison) => {
      const spotify = input.groundTruth.find(
        (release) => release.spotifyReleaseId === comparison.spotifyReleaseId,
      );
      const apple = catalog.collections.find(
        (collection) => collection.collectionId === comparison.appleCollectionId,
      );
      return Boolean(
        spotify && apple && normalizeText(spotify.title) === normalizeText(apple.collectionName),
      );
    }).length;
    const candidateTrackTitles = new Set(
      catalog.tracks.map((track) => normalizeText(track.trackName)),
    );
    const trackTitleOverlap = [...groundTruthTrackTitles].filter((title) =>
      candidateTrackTitles.has(title),
    ).length;
    const exactHighQualityMatch = matched.some(
      (comparison) =>
        comparison.classification === "exact_match" &&
        comparison.trackCountAgreement !== false &&
        (comparison.dateDifferenceDays ?? Number.POSITIVE_INFINITY) <= 1,
    );
    const creditCompatible =
      catalog.collections.some(
        (collection) =>
          collection.artistId === catalog.candidate.artistId ||
          collection.collectionArtistId === catalog.candidate.artistId,
      ) ||
      catalog.tracks.some(
        (track) =>
          track.artistId === catalog.candidate.artistId ||
          track.collectionArtistId === catalog.candidate.artistId,
      );
    const strongCatalogOverlap =
      nameCompatible &&
      creditCompatible &&
      conflicting.length === 0 &&
      (matched.length >= 2 ||
        (matched.length === 1 &&
          exactReleaseTitleMatches === 1 &&
          (exactHighQualityMatch || trackTitleOverlap >= 1)));
    const score =
      matched.length * 4 +
      exactReleaseTitleMatches * 2 +
      Math.min(trackTitleOverlap, 8) * 0.25 -
      conflicting.length * 3;
    const decision = !nameCompatible
      ? "reject"
      : strongCatalogOverlap
        ? "confirm"
        : conflicting.length > 0 && matched.length === 0
          ? "reject"
          : "ambiguous";
    return {
      artistId: catalog.candidate.artistId,
      confidence: strongCatalogOverlap
        ? Math.min(0.99, 0.8 + matched.length * 0.04 + Math.min(trackTitleOverlap, 5) * 0.01)
        : Math.max(0, Math.min(0.74, score / 10)),
      conflictingReleases: conflicting
        .map((comparison) => comparison.spotifyReleaseId)
        .filter((value): value is string => Boolean(value)),
      creditCompatible,
      decision,
      decisionReason: !nameCompatible
        ? "Candidate name is not an exact canonical or stored-alias match."
        : !creditCompatible
          ? "Returned catalog credits do not identify the candidate artist."
          : strongCatalogOverlap
            ? "Unique strong catalog overlap with compatible release evidence."
            : conflicting.length > 0 && matched.length === 0
              ? "Catalog evidence conflicts with frozen release identity."
              : "Catalog overlap is insufficient for deterministic identity confirmation.",
      evidenceExamined: [
        `${catalog.collections.length} normalized collections`,
        `${catalog.tracks.length} normalized tracks`,
        `${input.groundTruth.length} frozen releases`,
        "exact normalized release titles",
        "version markers",
        "release dates",
        "track counts",
        "track-title overlap",
        "artist-credit IDs",
      ],
      exactReleaseTitleMatches,
      matchedReleases: matched
        .map((comparison) => comparison.spotifyReleaseId)
        .filter((value): value is string => Boolean(value)),
      score,
      trackTitleOverlap,
    };
  });
  const confirmed = candidateEvidence
    .filter((evidence) => evidence.decision === "confirm")
    .sort((left, right) => right.score - left.score || left.artistId.localeCompare(right.artistId));
  const selectedEvidence = confirmed[0];
  const nextBest = candidateEvidence
    .filter((evidence) => evidence.artistId !== selectedEvidence?.artistId)
    .sort(
      (left, right) => right.score - left.score || left.artistId.localeCompare(right.artistId),
    )[0];
  const selectedCatalog = input.candidates.find(
    (catalog) => catalog.candidate.artistId === selectedEvidence?.artistId,
  );
  if (
    confirmed.length === 1 &&
    selectedEvidence &&
    selectedCatalog &&
    selectedEvidence.score - (nextBest?.score ?? 0) >= 2
  ) {
    return {
      candidateEvidence,
      confidence: selectedEvidence.confidence,
      evidence: [
        `candidate:${selectedEvidence.artistId}`,
        `matched_releases:${selectedEvidence.matchedReleases.length}`,
        `track_title_overlap:${selectedEvidence.trackTitleOverlap}`,
        `score_margin:${(selectedEvidence.score - (nextBest?.score ?? 0)).toFixed(2)}`,
      ],
      reason: "One same-name candidate has unique strong catalog overlap and no conflict.",
      selected: selectedCatalog.candidate,
      status: "evidence_confirmed",
    };
  }
  return {
    ambiguityReason:
      confirmed.length > 1
        ? "Multiple same-name candidates retain strong catalog evidence."
        : "No same-name candidate has unique strong catalog evidence.",
    candidateEvidence,
    confidence: 0,
    evidence: candidateEvidence.map(
      (evidence) =>
        `candidate:${evidence.artistId}:${evidence.decision}:score=${evidence.score.toFixed(2)}`,
    ),
    reason:
      confirmed.length > 1
        ? "Competing candidates remain plausible after catalog comparison."
        : "Catalog evidence is insufficient for identity confirmation.",
    status: "ambiguous",
  };
}

export function normalizeArtistIdentity(value: string): string {
  return normalizeText(value)
    .replace(/\b(feat|featuring|with|vs|versus)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function mergeItunesCollections(
  albumCollections: ItunesCollectionCandidate[],
  songCollections: ItunesCollectionCandidate[],
): ItunesCollectionCandidate[] {
  const merged = new Map<string, ItunesCollectionCandidate>();
  for (const candidate of albumCollections) {
    merged.set(candidate.collectionId, { ...candidate, source: "album_lookup" });
  }
  for (const candidate of songCollections) {
    const existing = merged.get(candidate.collectionId);
    merged.set(candidate.collectionId, {
      ...(existing ?? candidate),
      ...candidate,
      source: existing ? "both" : "song_lookup",
    });
  }
  return [...merged.values()].sort(compareDateThenId);
}

export function dedupeItunesTracks(tracks: ItunesTrackCandidate[]): ItunesTrackCandidate[] {
  return [...new Map(tracks.map((track) => [track.trackId, track])).values()].sort((a, b) => {
    const date = b.releaseDate.localeCompare(a.releaseDate);
    return date || a.trackId.localeCompare(b.trackId);
  });
}

export function classifyItunesCollectionType(
  collection: Pick<ItunesCollectionCandidate, "collectionName" | "trackCount">,
): string {
  const normalized = normalizeText(collection.collectionName);
  if (normalized.includes("remix")) return "remix";
  if (normalized.includes("live")) return "live";
  if (normalized.includes("compilation") || normalized.includes("various artists")) {
    return "compilation";
  }
  const count = collection.trackCount ?? 0;
  if (count <= 3) return "single";
  if (count <= 6) return "ep";
  return "album";
}

export function isItunesAppearance(mappedArtistId: string, track: ItunesTrackCandidate): boolean {
  return (
    track.artistId === mappedArtistId &&
    Boolean(track.collectionArtistId && track.collectionArtistId !== mappedArtistId)
  );
}

export function candidateInWindow(
  releaseDate: string,
  snapshotTimestamp: string,
  days: 7 | 14 | 30 | 60,
): boolean {
  const snapshot = new Date(snapshotTimestamp);
  const release = new Date(releaseDate);
  if (Number.isNaN(snapshot.getTime()) || Number.isNaN(release.getTime())) return false;
  const difference = snapshot.getTime() - release.getTime();
  return difference >= 0 && difference <= days * 86_400_000;
}

export function compareItunesToSpotify(
  groundTruth: SpotifyGroundTruthRelease[],
  collections: ItunesCollectionCandidate[],
): ItunesReleaseComparison[] {
  const comparisons: ItunesReleaseComparison[] = [];
  const matchedCollections = new Set<string>();
  for (const spotify of groundTruth) {
    const scored = collections
      .map((apple) => evaluateItunesReleasePair(spotify, apple))
      .filter((value): value is ItunesReleasePairEvaluation => Boolean(value))
      .sort(
        (left, right) =>
          comparisonRank(right.classification) - comparisonRank(left.classification) ||
          left.dateDifferenceDays - right.dateDifferenceDays ||
          left.apple.collectionId.localeCompare(right.apple.collectionId),
      );
    const best = scored[0];
    const tied =
      best &&
      scored[1] &&
      comparisonRank(scored[1].classification) === comparisonRank(best.classification) &&
      scored[1].dateDifferenceDays === best.dateDifferenceDays;
    if (!best) {
      comparisons.push({
        classification: "spotify_ground_truth_missed_by_itunes",
        reasons: ["No title-compatible iTunes collection was found."],
        spotifyReleaseId: spotify.spotifyReleaseId,
      });
      continue;
    }
    const classification: ItunesComparisonClassification = tied
      ? "ambiguous_match"
      : best.classification;
    if (["exact_match", "strong_probable_match"].includes(classification)) {
      matchedCollections.add(best.apple.collectionId);
    }
    comparisons.push({
      appleCollectionId: best.apple.collectionId,
      classification,
      dateDifferenceDays: best.dateDifferenceDays,
      reasons: [
        ...best.reasons,
        ...(tied ? ["Another collection has the same evidence rank and date distance."] : []),
      ],
      spotifyReleaseId: spotify.spotifyReleaseId,
      ...(best.trackCountAgreement === undefined
        ? {}
        : { trackCountAgreement: best.trackCountAgreement }),
    });
  }
  for (const apple of collections) {
    if (!matchedCollections.has(apple.collectionId)) {
      comparisons.push({
        appleCollectionId: apple.collectionId,
        classification: "apple_only_or_spotify_missing",
        reasons: ["No confirmed frozen Spotify ground-truth match was assigned."],
      });
    }
  }
  return comparisons;
}

export function evaluateItunesReleasePair(
  spotify: SpotifyGroundTruthRelease,
  apple: ItunesCollectionCandidate,
): ItunesReleasePairEvaluation | undefined {
  const spotifyTitle = normalizeText(spotify.title);
  const appleTitle = normalizeText(apple.collectionName);
  const titleEqual = spotifyTitle === appleTitle;
  const versionBaseEqual = baseTitle(spotifyTitle) === baseTitle(appleTitle);
  const contained =
    !titleEqual &&
    !versionBaseEqual &&
    (spotifyTitle.includes(appleTitle) || appleTitle.includes(spotifyTitle));
  if (!titleEqual && !contained && !versionBaseEqual) return undefined;

  const reasons = [
    titleEqual
      ? "Normalized titles are identical."
      : versionBaseEqual
        ? "Base titles agree after isolating version markers."
        : "One normalized title contains the other.",
  ];
  const spotifyVersion = spotify.version ?? extractVersion(spotify.title);
  const appleVersion = extractVersion(apple.collectionName);
  const versionConflict =
    spotifyVersion !== appleVersion && Boolean(spotifyVersion || appleVersion);
  const dateDifferenceDays = Math.abs(
    Math.round((Date.parse(spotify.releaseDate) - Date.parse(apple.releaseDate)) / 86_400_000),
  );
  const trackCountAgreement =
    spotify.trackCount !== undefined && apple.trackCount !== undefined
      ? spotify.trackCount === apple.trackCount
      : undefined;
  const spotifyType = normalizedReleaseType(spotify.releaseType, spotify.title, spotify.trackCount);
  const appleType = normalizedReleaseType(
    classifyItunesCollectionType(apple),
    apple.collectionName,
    apple.trackCount,
  );
  const typeConflict =
    (spotifyType === "single" && ["ep", "album"].includes(appleType)) ||
    (appleType === "single" && ["ep", "album"].includes(spotifyType));

  if (versionConflict) {
    return {
      apple,
      classification: "invalid_match",
      dateDifferenceDays,
      reasons: [
        ...reasons,
        "Version markers conflict; original, remix, live, and studio forms remain distinct.",
      ],
      ...(trackCountAgreement === undefined ? {} : { trackCountAgreement }),
    };
  }
  reasons.push("Version markers are compatible.");
  if (dateDifferenceDays > 30) {
    return {
      apple,
      classification: "invalid_match",
      dateDifferenceDays,
      reasons: [...reasons, "Release dates differ by more than 30 days without track-level proof."],
      ...(trackCountAgreement === undefined ? {} : { trackCountAgreement }),
    };
  }
  if (trackCountAgreement === false) {
    return {
      apple,
      classification: "invalid_match",
      dateDifferenceDays,
      reasons: [...reasons, "Track counts conflict."],
      trackCountAgreement,
    };
  }
  if (typeConflict) {
    return {
      apple,
      classification: "ambiguous_match",
      dateDifferenceDays,
      reasons: [
        ...reasons,
        "Single and album or EP appearances are related evidence, not the same confirmed release.",
      ],
      ...(trackCountAgreement === undefined ? {} : { trackCountAgreement }),
    };
  }
  if (dateDifferenceDays > 14) {
    return {
      apple,
      classification: "ambiguous_match",
      dateDifferenceDays,
      reasons: [...reasons, "Release dates differ by more than 14 days."],
      ...(trackCountAgreement === undefined ? {} : { trackCountAgreement }),
    };
  }
  if (titleEqual && dateDifferenceDays <= 1) {
    return {
      apple,
      classification: "exact_match",
      dateDifferenceDays,
      reasons: [
        ...reasons,
        "Release dates differ by at most one day.",
        ...(trackCountAgreement ? ["Track counts agree."] : []),
      ],
      ...(trackCountAgreement === undefined ? {} : { trackCountAgreement }),
    };
  }
  if (
    (titleEqual && dateDifferenceDays <= 7) ||
    (titleEqual && dateDifferenceDays <= 14 && trackCountAgreement === true) ||
    (versionBaseEqual && dateDifferenceDays <= 1 && trackCountAgreement === true) ||
    (contained && dateDifferenceDays <= 1 && trackCountAgreement === true)
  ) {
    return {
      apple,
      classification: "strong_probable_match",
      dateDifferenceDays,
      reasons: [
        ...reasons,
        dateDifferenceDays <= 1
          ? "Release dates differ by at most one day."
          : dateDifferenceDays <= 7
            ? "Release dates differ by at most seven days."
            : "Release dates differ by at most fourteen days with matching track counts.",
        ...(trackCountAgreement ? ["Track counts agree."] : []),
      ],
      ...(trackCountAgreement === undefined ? {} : { trackCountAgreement }),
    };
  }
  return {
    apple,
    classification: "ambiguous_match",
    dateDifferenceDays,
    reasons: [...reasons, "Evidence is insufficient for a confirmed cross-store release match."],
    ...(trackCountAgreement === undefined ? {} : { trackCountAgreement }),
  };
}

export function batchEquivalentToIndividuals(input: {
  batchCollections: ItunesCollectionCandidate[];
  batchTracks: ItunesTrackCandidate[];
  expectedArtistIds: string[];
  individualCollections: ItunesCollectionCandidate[];
  individualTracks: ItunesTrackCandidate[];
}): { reasons: string[]; safe: boolean } {
  const reasons: string[] = [];
  const expected = new Set(input.expectedArtistIds);
  const represented = new Set(
    [...input.batchCollections, ...input.batchTracks]
      .flatMap((item) => [item.artistId, item.collectionArtistId])
      .filter((value): value is string => Boolean(value)),
  );
  for (const artistId of expected) {
    if (!represented.has(artistId)) reasons.push(`missing_artist:${artistId}`);
  }
  const missingCollections = difference(
    input.individualCollections.map((item) => item.collectionId),
    input.batchCollections.map((item) => item.collectionId),
  );
  const missingTracks = difference(
    input.individualTracks.map((item) => item.trackId),
    input.batchTracks.map((item) => item.trackId),
  );
  if (missingCollections.length > 0)
    reasons.push(`missing_collections:${missingCollections.length}`);
  if (missingTracks.length > 0) reasons.push(`missing_tracks:${missingTracks.length}`);
  const unattributed = [...input.batchCollections, ...input.batchTracks].filter(
    (item) =>
      !item.artistId ||
      (!expected.has(item.artistId) &&
        (!item.collectionArtistId || !expected.has(item.collectionArtistId))),
  );
  if (unattributed.length > 0) reasons.push(`misattributed:${unattributed.length}`);
  return { reasons, safe: reasons.length === 0 };
}

function comparisonRank(classification: ItunesReleasePairEvaluation["classification"]): number {
  switch (classification) {
    case "exact_match":
      return 4;
    case "strong_probable_match":
      return 3;
    case "ambiguous_match":
      return 2;
    case "invalid_match":
      return 1;
  }
}

function normalizedReleaseType(
  releaseType: string,
  title: string,
  trackCount: number | undefined,
): string {
  const version = extractVersion(title);
  if (version === "remix") return "remix";
  if (version === "live") return "live";
  const normalized = normalizeText(releaseType);
  if (normalized.includes("remix")) return "remix";
  if (normalized.includes("live")) return "live";
  if (normalized.includes("single")) return "single";
  if (normalized === "ep" || normalized.includes("extended play")) return "ep";
  if (normalized.includes("album")) return "album";
  if (normalized.includes("compilation")) return "compilation";
  if (trackCount !== undefined) {
    if (trackCount <= 3) return "single";
    if (trackCount <= 6) return "ep";
    return "album";
  }
  return normalized;
}

function baseTitle(value: string): string {
  return value
    .replace(
      /\b(remix|live|radio edit|extended mix|clean|explicit|demo|acoustic|instrumental|remaster)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function difference(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return [...new Set(left)].filter((value) => !rightSet.has(value));
}

function compareDateThenId(a: ItunesCollectionCandidate, b: ItunesCollectionCandidate): number {
  const date = b.releaseDate.localeCompare(a.releaseDate);
  return date || a.collectionId.localeCompare(b.collectionId);
}
