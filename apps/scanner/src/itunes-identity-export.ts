import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  itunesPilotArtistMappings,
  itunesPilotProviderState,
  itunesPilotRequestEvents,
  itunesPilotResponseCache,
  itunesPilotRuns,
  type RadarDatabase,
} from "@radar/db";
import { and, count, eq } from "drizzle-orm";

export const identityExportSchemaVersion = 1;
export const identityExportExpectedBranch = "codex/itunes-discovery";
export const identityExportCensusFileSha256 =
  "ee785fcc0831c462ea7e4dbd59fc7c6fc9fccde652c30739212e69740b1913fa";
export const identityExportCensusCanonicalSha256 =
  "8b78dd990907e321f037ef16eb5b883ff369bea935d7024b22e0e7a9a184c33d";
export const identityExportInventoryFileSha256 =
  "8852c14806bbb564c59642f67a6c84466c31ded165f4990e9dc5889c7ab087bb";
export const identityExportEvidenceCutoff = "2026-07-30T02:10:30.000Z";
export const identityExportCorrectedRunId = "0f719ae6-bb42-48a0-b24c-557a0c2facb5";
export const identityExportPacingMs = 3_200;
export const identityExportAlternateCandidateLimit = 10;

export type IdentitySeedClassification =
  | "high_confidence_seed"
  | "evidence_supported_seed"
  | "ambiguous_seed"
  | "no_candidate"
  | "manual_review_required";

export type IdentitySeedConfidence = "high" | "evidence_supported" | "ambiguous" | "unresolved";

export interface IdentitySeedEntry {
  aliasMatchStatus: "none" | "unique" | "multiple";
  aliases: string[];
  alternateCandidateIds: string[];
  candidateArtistId?: string;
  canonicalArtistName: string;
  classification: IdentitySeedClassification;
  confidence: IdentitySeedConfidence;
  conflictingEvidenceCount: number;
  evidenceSources: string[];
  evidenceTimestamp: string;
  exactNameMatchStatus: "none" | "unique" | "multiple";
  manualReviewReason?: string;
  plausibleCandidateCount: number;
  publicArtistPageUrl?: string;
  releaseTitleOverlapCount: number;
  trackTitleOverlapCount: number;
  watchedArtistId: string;
}

export interface IdentitySeedArtifact {
  artifactSelfHash: string;
  canonicalWatchlistCount: number;
  classificationCounts: Record<IdentitySeedClassification, number>;
  createdAt: string;
  entries: IdentitySeedEntry[];
  evidenceCutoffDate: string;
  inputWatchlistHash: string;
  itunesRequestCountUsedForExport: number;
  schemaVersion: 1;
  sourceBranch: string;
  sourceCommit: string;
  storefront: "us";
}

export interface IdentityExportPlan {
  artifactPath: string;
  cacheEvidenceArtistCount: number;
  canonicalWatchlistCount: number;
  classificationCounts: Record<IdentitySeedClassification, number>;
  databaseWrites: 0;
  duplicateCanonicalNameCount: number;
  duplicateInternalArtistCount: number;
  evidenceSupportedMappingCount: number;
  expectedRuntimeMs: number;
  historicalItunesNetworkRequestCount: number;
  inputWatchlistHash: string;
  manualReviewCount: number;
  minimumRequestStartIntervalMs: 3200;
  networkRequestForecast: number;
  reportPath: string;
  sourceBranch: string;
  sourceCommit: string;
}

export interface IdentityExportDatabaseEvidence {
  activeLease: boolean;
  activeRun: boolean;
  evidenceMappings: ExistingEvidenceMapping[];
  historicalNetworkRequestCount: number;
  providerCooldownActive: boolean;
  publicArtistUrls: ReadonlyMap<string, string>;
}

interface ExistingEvidenceMapping {
  candidates: unknown;
  canonicalArtistId: string;
  evidence: unknown;
  selectedArtistId: string;
}

interface CensusArtist {
  aliases: string[];
  candidates: Array<{ artistId: string; artistName: string }>;
  canonicalArtistId: string;
  declaredResultCount: number;
  displayName: string;
  exactAliasCandidateCount: number;
  exactCanonicalCandidateCount: number;
  normalizedName: string;
  plausibleCandidateIds: string[];
  searchStageMappingState: string;
  terminalProcessingState: string;
}

interface CensusInput {
  artists: CensusArtist[];
  canonicalContentSha256: string;
  completenessState: string;
  kind: string;
}

interface InventoryRow {
  anchorQuality: string;
  canonicalArtistId: string;
  canonicalName: string;
  noUsableHistoricalEvidence: boolean;
  usableIdentityAnchorCount: number;
}

export async function readIdentityExportInputs(input: {
  censusPath: string;
  inventoryPath: string;
}): Promise<{ census: CensusInput; inventory: InventoryRow[] }> {
  const censusBytes = await readFile(resolve(input.censusPath));
  if (sha256(censusBytes) !== identityExportCensusFileSha256) {
    throw new Error("The full-watchlist census file hash differs from the frozen checkpoint.");
  }
  const census = parseCensus(JSON.parse(censusBytes.toString("utf8")));
  if (
    census.kind !== "itunes_full_watchlist_search_census" ||
    census.completenessState !== "complete" ||
    census.canonicalContentSha256 !== identityExportCensusCanonicalSha256 ||
    census.artists.length !== 593
  ) {
    throw new Error("The full-watchlist census is incomplete or differs from the frozen input.");
  }

  const inventoryBytes = await readFile(resolve(input.inventoryPath));
  if (sha256(inventoryBytes) !== identityExportInventoryFileSha256) {
    throw new Error("The identity-evidence inventory hash differs from the frozen checkpoint.");
  }
  const inventory = parseInventoryCsv(inventoryBytes.toString("utf8"));
  if (inventory.length !== census.artists.length) {
    throw new Error("The census and identity-evidence inventory artist counts differ.");
  }
  return { census, inventory };
}

export async function loadIdentityExportDatabaseEvidence(
  db: RadarDatabase,
  now = new Date(),
): Promise<IdentityExportDatabaseEvidence> {
  const mappings = await db
    .select({
      candidates: itunesPilotArtistMappings.candidates,
      canonicalArtistId: itunesPilotArtistMappings.canonicalArtistId,
      evidence: itunesPilotArtistMappings.evidence,
      selectedArtistId: itunesPilotArtistMappings.selectedArtistId,
    })
    .from(itunesPilotArtistMappings)
    .where(
      and(
        eq(itunesPilotArtistMappings.runId, identityExportCorrectedRunId),
        eq(itunesPilotArtistMappings.status, "evidence_confirmed"),
      ),
    );
  const cacheRows = await db
    .select({ response: itunesPilotResponseCache.response })
    .from(itunesPilotResponseCache);
  const networkCount = await db
    .select({ value: count() })
    .from(itunesPilotRequestEvents)
    .where(eq(itunesPilotRequestEvents.cacheHit, false));
  const runs = await db.select({ status: itunesPilotRuns.status }).from(itunesPilotRuns);
  const providerState = await db.query.itunesPilotProviderState.findFirst({
    where: eq(itunesPilotProviderState.id, "global"),
  });
  const publicArtistUrls = new Map<string, string>();
  for (const row of cacheRows) collectPublicArtistUrls(row.response, publicArtistUrls);
  const evidenceMappings = mappings.map((mapping) => {
    if (!mapping.selectedArtistId || !numericId(mapping.selectedArtistId)) {
      throw new Error("An evidence-supported mapping lacks a valid selected public artist ID.");
    }
    return {
      candidates: mapping.candidates,
      canonicalArtistId: mapping.canonicalArtistId,
      evidence: mapping.evidence,
      selectedArtistId: mapping.selectedArtistId,
    };
  });
  return {
    activeLease: Boolean(
      providerState?.leaseOwner &&
      providerState.leaseExpiresAt &&
      providerState.leaseExpiresAt.getTime() > now.getTime(),
    ),
    activeRun: runs.some((run) => run.status === "planned" || run.status === "running"),
    evidenceMappings,
    historicalNetworkRequestCount: networkCount[0]?.value ?? 0,
    providerCooldownActive: Boolean(
      providerState?.nextRequestAt && providerState.nextRequestAt.getTime() > now.getTime(),
    ),
    publicArtistUrls,
  };
}

export function createIdentityExportPlan(input: {
  artifactPath: string;
  branch: string;
  census: CensusInput;
  databaseEvidence: IdentityExportDatabaseEvidence;
  inventory: InventoryRow[];
  reportPath: string;
  sourceCommit: string;
}): IdentityExportPlan {
  validateSource(input.branch, input.sourceCommit);
  validateDatabaseEvidence(input.databaseEvidence);
  validateExpectedEvidenceMappingCount(input.census, input.databaseEvidence);
  const entries = buildIdentitySeedEntries({
    census: input.census,
    databaseEvidence: input.databaseEvidence,
    inventory: input.inventory,
  });
  const duplicateInternalArtistCount = duplicateCount(
    entries.map((entry) => entry.watchedArtistId),
  );
  const duplicateCanonicalNameCount = duplicateCount(
    entries.map((entry) => normalizeName(entry.canonicalArtistName)),
  );
  if (duplicateInternalArtistCount > 0) {
    throw new Error("Duplicate internal watched-artist identities are not exportable.");
  }
  const classificationCounts = countClassifications(entries);
  const networkRequestForecast = input.census.artists.filter(
    (artist) => artist.terminalProcessingState !== "completed",
  ).length;
  return {
    artifactPath: portablePath(input.artifactPath),
    cacheEvidenceArtistCount: input.census.artists.length - networkRequestForecast,
    canonicalWatchlistCount: entries.length,
    classificationCounts,
    databaseWrites: 0,
    duplicateCanonicalNameCount,
    duplicateInternalArtistCount,
    evidenceSupportedMappingCount: classificationCounts.evidence_supported_seed,
    expectedRuntimeMs: networkRequestForecast * identityExportPacingMs,
    historicalItunesNetworkRequestCount: input.databaseEvidence.historicalNetworkRequestCount,
    inputWatchlistHash: watchlistHash(entries),
    manualReviewCount:
      classificationCounts.ambiguous_seed + classificationCounts.manual_review_required,
    minimumRequestStartIntervalMs: identityExportPacingMs,
    networkRequestForecast,
    reportPath: portablePath(input.reportPath),
    sourceBranch: input.branch,
    sourceCommit: input.sourceCommit,
  };
}

export function assertIdentityExportCanExecute(plan: IdentityExportPlan): void {
  if (plan.networkRequestForecast !== 0) {
    throw new Error(
      "Identity export refuses uncached work. Resume the existing paced census workflow first.",
    );
  }
}

export function buildIdentitySeedArtifact(input: {
  branch: string;
  census: CensusInput;
  createdAt: string;
  databaseEvidence: IdentityExportDatabaseEvidence;
  inventory: InventoryRow[];
  sourceCommit: string;
}): IdentitySeedArtifact {
  validateSource(input.branch, input.sourceCommit);
  validateDatabaseEvidence(input.databaseEvidence);
  validateExpectedEvidenceMappingCount(input.census, input.databaseEvidence);
  const createdAt = isoTimestamp(input.createdAt, "creation timestamp");
  const entries = buildIdentitySeedEntries({
    census: input.census,
    databaseEvidence: input.databaseEvidence,
    inventory: input.inventory,
  });
  if (input.census.artists.some((artist) => artist.terminalProcessingState !== "completed")) {
    throw new Error(
      "The frozen census is incomplete. Run the existing resumable census workflow before export.",
    );
  }
  const content: Omit<IdentitySeedArtifact, "artifactSelfHash"> = {
    canonicalWatchlistCount: entries.length,
    classificationCounts: countClassifications(entries),
    createdAt,
    entries,
    evidenceCutoffDate: identityExportEvidenceCutoff,
    inputWatchlistHash: watchlistHash(entries),
    itunesRequestCountUsedForExport: 0,
    schemaVersion: identityExportSchemaVersion,
    sourceBranch: input.branch,
    sourceCommit: input.sourceCommit,
    storefront: "us",
  };
  const artifact: IdentitySeedArtifact = {
    ...content,
    artifactSelfHash: sha256(canonicalJson(content)),
  };
  parseIdentitySeedArtifact(artifact);
  assertSanitizedArtifact(artifact);
  return artifact;
}

export async function writeIdentitySeedExport(input: {
  artifact: IdentitySeedArtifact;
  artifactPath: string;
  reportPath: string;
}): Promise<{
  artifactPath: string;
  artifactSelfHash: string;
  fileByteSha256: string;
  reportPath: string;
}> {
  const parsed = parseIdentitySeedArtifact(input.artifact);
  const artifactBytes = `${JSON.stringify(parsed, null, 2)}\n`;
  const repeatBytes = `${JSON.stringify(parseIdentitySeedArtifact(JSON.parse(artifactBytes)), null, 2)}\n`;
  if (artifactBytes !== repeatBytes) {
    throw new Error("Repeated identity-seed serialization was not deterministic.");
  }
  const artifactPath = resolve(input.artifactPath);
  const reportPath = resolve(input.reportPath);
  await mkdir(dirname(artifactPath), { recursive: true });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(artifactPath, artifactBytes, { encoding: "utf8", flag: "wx" });
  await writeFile(reportPath, renderIdentitySeedReport(parsed), { encoding: "utf8", flag: "wx" });
  return {
    artifactPath: portablePath(input.artifactPath),
    artifactSelfHash: parsed.artifactSelfHash,
    fileByteSha256: sha256(artifactBytes),
    reportPath: portablePath(input.reportPath),
  };
}

export function parseIdentitySeedArtifact(value: unknown): IdentitySeedArtifact {
  const record = requiredRecord(value, "identity-seed artifact");
  if (record.schemaVersion !== 1) throw new Error("Unsupported identity-seed schema version.");
  if (record.storefront !== "us") throw new Error("Identity-seed storefront must be us.");
  const entries = requiredArray(record.entries, "entries").map(parseEntry);
  if (
    requiredInteger(record.canonicalWatchlistCount, "canonicalWatchlistCount") !== entries.length
  ) {
    throw new Error("Identity-seed watchlist count does not match its entries.");
  }
  if (duplicateCount(entries.map((entry) => entry.watchedArtistId)) > 0) {
    throw new Error("Identity-seed entries contain duplicate internal artist identities.");
  }
  const artifact = record as unknown as IdentitySeedArtifact;
  const actualCounts = countClassifications(entries);
  if (canonicalJson(record.classificationCounts) !== canonicalJson(actualCounts)) {
    throw new Error("Identity-seed classification totals do not match its entries.");
  }
  if (sumCounts(actualCounts) !== entries.length) {
    throw new Error("Identity-seed classification totals do not equal the watchlist count.");
  }
  const expectedHash = requiredHash(record.artifactSelfHash, "artifactSelfHash");
  const content = Object.fromEntries(
    Object.entries(artifact).filter(([key]) => key !== "artifactSelfHash"),
  );
  if (sha256(canonicalJson(content)) !== expectedHash) {
    throw new Error("Identity-seed artifact self-hash validation failed.");
  }
  requiredHash(record.inputWatchlistHash, "inputWatchlistHash");
  requiredFullCommit(record.sourceCommit, "sourceCommit");
  requiredString(record.sourceBranch, "sourceBranch");
  isoTimestamp(requiredString(record.createdAt, "createdAt"), "createdAt");
  isoTimestamp(
    requiredString(record.evidenceCutoffDate, "evidenceCutoffDate"),
    "evidenceCutoffDate",
  );
  if (
    requiredInteger(record.itunesRequestCountUsedForExport, "itunesRequestCountUsedForExport") < 0
  ) {
    throw new Error("Identity-seed request count cannot be negative.");
  }
  assertSanitizedArtifact(artifact);
  return artifact;
}

export function renderIdentitySeedReport(artifact: IdentitySeedArtifact): string {
  const manual = artifact.entries.filter(
    (entry) =>
      entry.classification === "ambiguous_seed" ||
      entry.classification === "manual_review_required",
  );
  const duplicateNames = duplicateGroups(
    artifact.entries.map((entry) => ({
      id: entry.watchedArtistId,
      name: entry.canonicalArtistName,
    })),
  );
  const lines = [
    "# Apple Music Identity Seed Export",
    "",
    `Created: ${artifact.createdAt}`,
    "",
    "## Result",
    "",
    `- Active watched artists: ${artifact.canonicalWatchlistCount}`,
    `- High-confidence iTunes candidates: ${artifact.classificationCounts.high_confidence_seed}`,
    `- Evidence-supported iTunes candidates: ${artifact.classificationCounts.evidence_supported_seed}`,
    `- Ambiguous candidate sets: ${artifact.classificationCounts.ambiguous_seed}`,
    `- No candidate: ${artifact.classificationCounts.no_candidate}`,
    `- Manual-review-required without a candidate: ${artifact.classificationCounts.manual_review_required}`,
    `- Total Apple-side or human review queue: ${manual.length}`,
    `- Duplicate canonical-name groups: ${duplicateNames.length}`,
    "- New iTunes requests: 0",
    "- HTTP errors, retries, throttling, and cooldown changes: 0",
    "- Runtime attributable to provider requests: 0 ms",
    "",
    "These are public iTunes identity candidates, not confirmed Apple Music mappings. Search rank, popularity, and genre were not used to confirm any candidate.",
    "",
    "## Artifact contract",
    "",
    `- Schema version: ${artifact.schemaVersion}`,
    `- Storefront: ${artifact.storefront}`,
    `- Input watchlist hash: \`${artifact.inputWatchlistHash}\``,
    `- Artifact self-hash: \`${artifact.artifactSelfHash}\``,
    `- Evidence cutoff: ${artifact.evidenceCutoffDate}`,
    "- Every watched artist appears exactly once under its stable internal identifier.",
    "- Candidate IDs are public catalog identifiers. The artifact contains no provider credentials, raw responses, artwork, previews, account data, or machine-specific paths.",
    "- The Apple branch can verify the self-hash, match entries by internal identifier, look up a candidate, preserve ambiguity, and create a smaller review queue without this database or cache.",
    "",
    "## Candidate-generation limitations",
    "",
    "- A unique exact normalized name is a high-confidence seed only. It is not Apple confirmation.",
    "- Evidence-supported seeds reuse the previously corrected iTunes resolver result. Only overlap counts and conflict counts are exported, not source-provider identifiers or titles.",
    "- Ambiguous seeds preserve every plausible exact-name or approved-alias candidate up to the search limit of 10.",
    "- A search result limit of 10 creates truncation risk. A correct identity may be outside the retained shortlist.",
    "- No approved aliases were available in the frozen 593-artist watchlist.",
    "",
    "## Manual review",
    "",
    "For each row, a human should compare the Apple Music artist page's canonical credit and catalog with the intended artist. Do not accept a page from rank, popularity, genre, or a single common title.",
    "",
    "| Canonical artist | Aliases | Candidates | Sanitized evidence | Why automation stopped | Human verification |",
    "| :-- | :-- | --: | :-- | :-- | :-- |",
    ...manual
      .map((entry) =>
        [
          escapeTable(entry.canonicalArtistName),
          entry.aliases.length > 0 ? escapeTable(entry.aliases.join(", ")) : "None",
          String(entry.plausibleCandidateCount),
          escapeTable(
            `Exact-name ${entry.exactNameMatchStatus}; release overlap ${entry.releaseTitleOverlapCount}; track overlap ${entry.trackTitleOverlapCount}; conflicts ${entry.conflictingEvidenceCount}.`,
          ),
          escapeTable(entry.manualReviewReason ?? "Ambiguity remains."),
          "Confirm the intended artist name or approved alias and corroborate multiple distinctive catalog items; otherwise retain ambiguity.",
        ].join(" | "),
      )
      .map((row) => `| ${row} |`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function buildIdentitySeedEntries(input: {
  census: CensusInput;
  databaseEvidence: IdentityExportDatabaseEvidence;
  inventory: InventoryRow[];
}): IdentitySeedEntry[] {
  const inventoryById = uniqueMap(input.inventory, (row) => row.canonicalArtistId, "inventory");
  const mappingById = uniqueMap(
    input.databaseEvidence.evidenceMappings,
    (mapping) => mapping.canonicalArtistId,
    "evidence mappings",
  );
  const entries = [...input.census.artists]
    .sort(
      (left, right) =>
        compareText(left.normalizedName, right.normalizedName) ||
        compareText(left.canonicalArtistId, right.canonicalArtistId),
    )
    .map((artist): IdentitySeedEntry => {
      const inventory = inventoryById.get(artist.canonicalArtistId);
      if (!inventory || inventory.canonicalName !== artist.displayName) {
        throw new Error(
          `Identity evidence is missing or mismatched for ${artist.canonicalArtistId}.`,
        );
      }
      validateCensusArtist(artist);
      const mapping = mappingById.get(artist.canonicalArtistId);
      const base = baseEntry(artist, inventory);
      if (mapping) return evidenceSupportedEntry(base, artist, mapping, input.databaseEvidence);
      if (artist.searchStageMappingState === "unique_exact_canonical") {
        const candidateArtistId = artist.plausibleCandidateIds[0];
        if (!candidateArtistId) throw new Error("Unique exact-name mapping has no candidate ID.");
        const publicArtistPageUrl = safePublicArtistUrl(
          input.databaseEvidence.publicArtistUrls.get(candidateArtistId),
        );
        return {
          ...base,
          candidateArtistId,
          classification: "high_confidence_seed",
          confidence: "high",
          evidenceSources: ["cached_itunes_artist_search", "exact_normalized_canonical_name"],
          ...(publicArtistPageUrl ? { publicArtistPageUrl } : {}),
        };
      }
      if (artist.searchStageMappingState === "unique_alias_supported") {
        const candidateArtistId = artist.plausibleCandidateIds[0];
        if (
          !candidateArtistId ||
          artist.aliases.length === 0 ||
          artist.exactAliasCandidateCount !== 1
        ) {
          throw new Error("Unique alias mapping lacks one approved alias candidate.");
        }
        const candidate = artist.candidates.find((item) => item.artistId === candidateArtistId);
        const approvedAliases = new Set(artist.aliases.map(normalizeName));
        if (!candidate || !approvedAliases.has(normalizeName(candidate.artistName))) {
          throw new Error("Unique alias mapping is not supported by an approved alias.");
        }
        const publicArtistPageUrl = safePublicArtistUrl(
          input.databaseEvidence.publicArtistUrls.get(candidateArtistId),
        );
        return {
          ...base,
          candidateArtistId,
          classification: "high_confidence_seed",
          confidence: "high",
          evidenceSources: ["cached_itunes_artist_search", "exact_approved_alias"],
          ...(publicArtistPageUrl ? { publicArtistPageUrl } : {}),
        };
      }
      if (artist.searchStageMappingState === "competing_exact_or_alias") {
        const resultLimited = artist.declaredResultCount >= identityExportAlternateCandidateLimit;
        return {
          ...base,
          alternateCandidateIds: artist.plausibleCandidateIds.slice(
            0,
            identityExportAlternateCandidateLimit,
          ),
          classification: "ambiguous_seed",
          confidence: "ambiguous",
          evidenceSources: [
            "cached_itunes_artist_search",
            "multiple_exact_normalized_name_candidates",
            ...(inventory.noUsableHistoricalEvidence
              ? []
              : ["sanitized_historical_anchor_inventory"]),
          ],
          manualReviewReason: resultLimited
            ? "Multiple exact-name candidates remain and the 10-result search limit creates truncation risk."
            : "Multiple exact-name candidates remain and existing evidence does not uniquely identify one.",
        };
      }
      if (artist.candidates.length === 0) {
        return {
          ...base,
          classification: "no_candidate",
          confidence: "unresolved",
          evidenceSources: ["cached_itunes_artist_search", "no_returned_artist_candidate"],
          manualReviewReason: "The cached artist search returned no candidate.",
        };
      }
      return {
        ...base,
        classification: "manual_review_required",
        confidence: "unresolved",
        evidenceSources: ["cached_itunes_artist_search", "no_exact_or_approved_alias_candidate"],
        manualReviewReason:
          "Search returned candidates, but none exactly matched the canonical name or an approved alias.",
      };
    });
  if (mappingById.size !== input.databaseEvidence.evidenceMappings.length) {
    throw new Error("Evidence-supported mapping identities are duplicated.");
  }
  const unusedMappings = [...mappingById.keys()].filter(
    (id) => !entries.some((entry) => entry.watchedArtistId === id),
  );
  if (unusedMappings.length > 0) {
    throw new Error("An evidence-supported mapping is outside the authoritative watchlist.");
  }
  return entries;
}

function baseEntry(artist: CensusArtist, inventory: InventoryRow): IdentitySeedEntry {
  return {
    aliasMatchStatus:
      artist.exactAliasCandidateCount === 0
        ? "none"
        : artist.exactAliasCandidateCount === 1
          ? "unique"
          : "multiple",
    aliases: [...artist.aliases].sort(compareText),
    alternateCandidateIds: [],
    canonicalArtistName: artist.displayName,
    classification: "manual_review_required",
    confidence: "unresolved",
    conflictingEvidenceCount: 0,
    evidenceSources: [
      "cached_itunes_artist_search",
      ...(inventory.usableIdentityAnchorCount > 0
        ? [`sanitized_historical_anchor_inventory:${inventory.anchorQuality}`]
        : []),
    ],
    evidenceTimestamp: identityExportEvidenceCutoff,
    exactNameMatchStatus:
      artist.exactCanonicalCandidateCount === 0
        ? "none"
        : artist.exactCanonicalCandidateCount === 1
          ? "unique"
          : "multiple",
    plausibleCandidateCount: artist.plausibleCandidateIds.length,
    releaseTitleOverlapCount: 0,
    trackTitleOverlapCount: 0,
    watchedArtistId: artist.canonicalArtistId,
  };
}

function evidenceSupportedEntry(
  base: IdentitySeedEntry,
  artist: CensusArtist,
  mapping: ExistingEvidenceMapping,
  databaseEvidence: IdentityExportDatabaseEvidence,
): IdentitySeedEntry {
  if (!artist.plausibleCandidateIds.includes(mapping.selectedArtistId)) {
    throw new Error("Evidence-supported mapping is outside the artist's plausible census IDs.");
  }
  const selectedEvidence = candidateEvidence(mapping.evidence, mapping.selectedArtistId);
  const publicArtistPageUrl =
    candidatePublicUrl(mapping.candidates, mapping.selectedArtistId) ??
    safePublicArtistUrl(databaseEvidence.publicArtistUrls.get(mapping.selectedArtistId));
  return {
    ...base,
    alternateCandidateIds: artist.plausibleCandidateIds
      .filter((id) => id !== mapping.selectedArtistId)
      .slice(0, identityExportAlternateCandidateLimit),
    candidateArtistId: mapping.selectedArtistId,
    classification: "evidence_supported_seed",
    confidence: "evidence_supported",
    conflictingEvidenceCount: selectedEvidence.conflictingEvidenceCount,
    evidenceSources: [
      "cached_itunes_artist_search",
      "corrected_itunes_catalog_evidence_resolver",
      "sanitized_release_and_track_overlap_counts",
    ],
    ...(publicArtistPageUrl ? { publicArtistPageUrl } : {}),
    releaseTitleOverlapCount: selectedEvidence.releaseTitleOverlapCount,
    trackTitleOverlapCount: selectedEvidence.trackTitleOverlapCount,
  };
}

function candidateEvidence(
  value: unknown,
  selectedArtistId: string,
): {
  conflictingEvidenceCount: number;
  releaseTitleOverlapCount: number;
  trackTitleOverlapCount: number;
} {
  for (const item of Array.isArray(value) ? value : []) {
    if (
      !isRecord(item) ||
      typeof item.artistId !== "string" ||
      item.artistId !== selectedArtistId
    ) {
      continue;
    }
    return {
      conflictingEvidenceCount: Array.isArray(item.conflictingReleases)
        ? item.conflictingReleases.length
        : 0,
      releaseTitleOverlapCount: nonnegativeInteger(item.exactReleaseTitleMatches),
      trackTitleOverlapCount: nonnegativeInteger(item.trackTitleOverlap),
    };
  }
  throw new Error("Selected evidence-supported mapping lacks sanitized candidate evidence.");
}

function candidatePublicUrl(value: unknown, selectedArtistId: string): string | undefined {
  for (const item of Array.isArray(value) ? value : []) {
    if (
      !isRecord(item) ||
      typeof item.artistId !== "string" ||
      item.artistId !== selectedArtistId
    ) {
      continue;
    }
    return safePublicArtistUrl(item.artistViewUrl) ?? safePublicArtistUrl(item.artistLinkUrl);
  }
  return undefined;
}

function collectPublicArtistUrls(value: unknown, output: Map<string, string>): void {
  if (!isRecord(value) || !Array.isArray(value.artists)) return;
  for (const item of value.artists) {
    if (!isRecord(item)) continue;
    const artistId = typeof item.artistId === "string" ? item.artistId : "";
    if (!numericId(artistId)) continue;
    const url = safePublicArtistUrl(item.artistViewUrl) ?? safePublicArtistUrl(item.artistLinkUrl);
    if (url && !output.has(artistId)) output.set(artistId, url);
  }
}

function safePublicArtistUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !(
        url.hostname === "music.apple.com" ||
        url.hostname === "itunes.apple.com" ||
        url.hostname.endsWith(".itunes.apple.com")
      )
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function parseCensus(value: unknown): CensusInput {
  const record = requiredRecord(value, "census");
  return {
    artists: requiredArray(record.artists, "census artists").map((item) => {
      const artist = requiredRecord(item, "census artist");
      return {
        aliases: requiredStringArray(artist.aliases, "aliases"),
        candidates: requiredArray(artist.candidates, "candidates").map((candidate) => {
          const candidateRecord = requiredRecord(candidate, "candidate");
          return {
            artistId: requiredNumericId(candidateRecord.artistId, "candidate artistId"),
            artistName: requiredString(candidateRecord.artistName, "candidate artistName"),
          };
        }),
        canonicalArtistId: requiredUuid(artist.canonicalArtistId, "canonicalArtistId"),
        declaredResultCount: requiredInteger(artist.declaredResultCount, "declaredResultCount"),
        displayName: requiredString(artist.displayName, "displayName"),
        exactAliasCandidateCount: requiredInteger(
          artist.exactAliasCandidateCount,
          "exactAliasCandidateCount",
        ),
        exactCanonicalCandidateCount: requiredInteger(
          artist.exactCanonicalCandidateCount,
          "exactCanonicalCandidateCount",
        ),
        normalizedName: requiredString(artist.normalizedName, "normalizedName"),
        plausibleCandidateIds: requiredStringArray(
          artist.plausibleCandidateIds,
          "plausibleCandidateIds",
        ).map((id) => requiredNumericId(id, "plausible candidate ID")),
        searchStageMappingState: requiredString(
          artist.searchStageMappingState,
          "searchStageMappingState",
        ),
        terminalProcessingState: requiredString(
          artist.terminalProcessingState,
          "terminalProcessingState",
        ),
      };
    }),
    canonicalContentSha256: requiredHash(
      record.canonicalContentSha256,
      "census canonicalContentSha256",
    ),
    completenessState: requiredString(record.completenessState, "census completenessState"),
    kind: requiredString(record.kind, "census kind"),
  };
}

function parseInventoryCsv(value: string): InventoryRow[] {
  const rows = parseCsv(value);
  const header = rows.shift();
  if (!header) throw new Error("The identity-evidence inventory is empty.");
  const expected = [
    "canonical_artist_id",
    "canonical_name",
    "search_stage_mapping_state",
    "plausible_apple_candidate_count",
    "result_limit_reached",
    "historical_release_count",
    "complete_historical_release_count",
    "historical_track_count",
    "usable_identity_anchor_count",
    "anchor_score",
    "anchor_quality",
    "earliest_usable_evidence_date",
    "latest_usable_evidence_date",
    "exact_historical_release_titles",
    "distinctive_track_titles",
    "album_or_ep_evidence",
    "single_only_evidence",
    "remix_only_evidence",
    "feature_only_evidence",
    "no_usable_historical_evidence",
  ];
  if (header.join("\u0000") !== expected.join("\u0000")) {
    throw new Error("The identity-evidence inventory columns changed unexpectedly.");
  }
  return rows.map((row) => {
    if (row.length !== expected.length) throw new Error("An inventory row has the wrong width.");
    return {
      anchorQuality: row[10] ?? "",
      canonicalArtistId: requiredUuid(row[0], "inventory canonical artist ID"),
      canonicalName: requiredString(row[1], "inventory canonical name"),
      noUsableHistoricalEvidence: requiredBooleanString(
        row[19],
        "inventory no-usable-evidence flag",
      ),
      usableIdentityAnchorCount: requiredIntegerString(row[8], "inventory usable anchor count"),
    };
  });
}

function parseCsv(value: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '"') {
      if (quoted && value[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && value[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((item) => item.length > 0)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("The identity-evidence CSV has an unterminated quoted field.");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function validateCensusArtist(artist: CensusArtist): void {
  if (artist.terminalProcessingState !== "completed") return;
  if (duplicateCount(artist.plausibleCandidateIds) > 0) {
    throw new Error("A census artist has duplicate plausible candidate IDs.");
  }
  if (artist.plausibleCandidateIds.length > identityExportAlternateCandidateLimit) {
    throw new Error("A census artist exceeds the bounded alternate-candidate limit.");
  }
  const candidateIds = new Set(artist.candidates.map((candidate) => candidate.artistId));
  if (artist.plausibleCandidateIds.some((id) => !candidateIds.has(id))) {
    throw new Error("A plausible candidate ID is missing from sanitized census candidates.");
  }
}

function validateSource(branch: string, sourceCommit: string): void {
  if (branch !== identityExportExpectedBranch) {
    throw new Error(`Identity export requires branch ${identityExportExpectedBranch}.`);
  }
  requiredFullCommit(sourceCommit, "sourceCommit");
}

function validateDatabaseEvidence(evidence: IdentityExportDatabaseEvidence): void {
  if (evidence.activeRun || evidence.activeLease) {
    throw new Error("Identity export requires no active iTunes run or request lease.");
  }
  if (evidence.providerCooldownActive) {
    throw new Error("Identity export will not run while an iTunes provider cooldown is active.");
  }
}

function validateExpectedEvidenceMappingCount(
  census: CensusInput,
  evidence: IdentityExportDatabaseEvidence,
): void {
  if (census.artists.length === 593 && evidence.evidenceMappings.length !== 13) {
    throw new Error(
      "The corrected evidence-supported mapping set must contain exactly 13 artists.",
    );
  }
}

function parseEntry(value: unknown): IdentitySeedEntry {
  const entry = requiredRecord(value, "identity-seed entry");
  const classification = requiredString(entry.classification, "classification");
  if (!identitySeedClassifications.includes(classification as IdentitySeedClassification)) {
    throw new Error("Identity-seed entry has an invalid classification.");
  }
  const candidateArtistId =
    entry.candidateArtistId === undefined
      ? undefined
      : requiredNumericId(entry.candidateArtistId, "candidateArtistId");
  const alternateCandidateIds = requiredStringArray(
    entry.alternateCandidateIds,
    "alternateCandidateIds",
  ).map((id) => requiredNumericId(id, "alternate candidate ID"));
  if (alternateCandidateIds.length > identityExportAlternateCandidateLimit) {
    throw new Error("Identity-seed alternate candidates exceed the bounded limit.");
  }
  if (
    duplicateCount(alternateCandidateIds) > 0 ||
    alternateCandidateIds.includes(candidateArtistId ?? "")
  ) {
    throw new Error("Identity-seed candidate IDs are duplicated.");
  }
  const publicArtistPageUrl =
    entry.publicArtistPageUrl === undefined
      ? undefined
      : safePublicArtistUrl(requiredString(entry.publicArtistPageUrl, "publicArtistPageUrl"));
  if (entry.publicArtistPageUrl !== undefined && !publicArtistPageUrl) {
    throw new Error("Identity-seed public artist URL is unsafe.");
  }
  return {
    aliasMatchStatus: requiredMatchStatus(entry.aliasMatchStatus, "aliasMatchStatus"),
    aliases: requiredStringArray(entry.aliases, "aliases"),
    alternateCandidateIds,
    ...(candidateArtistId ? { candidateArtistId } : {}),
    canonicalArtistName: requiredString(entry.canonicalArtistName, "canonicalArtistName"),
    classification: classification as IdentitySeedClassification,
    confidence: requiredConfidence(entry.confidence),
    conflictingEvidenceCount: requiredInteger(
      entry.conflictingEvidenceCount,
      "conflictingEvidenceCount",
    ),
    evidenceSources: requiredStringArray(entry.evidenceSources, "evidenceSources"),
    evidenceTimestamp: isoTimestamp(
      requiredString(entry.evidenceTimestamp, "evidenceTimestamp"),
      "evidenceTimestamp",
    ),
    exactNameMatchStatus: requiredMatchStatus(entry.exactNameMatchStatus, "exactNameMatchStatus"),
    ...(entry.manualReviewReason === undefined
      ? {}
      : { manualReviewReason: requiredString(entry.manualReviewReason, "manualReviewReason") }),
    plausibleCandidateCount: requiredInteger(
      entry.plausibleCandidateCount,
      "plausibleCandidateCount",
    ),
    ...(publicArtistPageUrl ? { publicArtistPageUrl } : {}),
    releaseTitleOverlapCount: requiredInteger(
      entry.releaseTitleOverlapCount,
      "releaseTitleOverlapCount",
    ),
    trackTitleOverlapCount: requiredInteger(entry.trackTitleOverlapCount, "trackTitleOverlapCount"),
    watchedArtistId: requiredUuid(entry.watchedArtistId, "watchedArtistId"),
  };
}

const identitySeedClassifications: IdentitySeedClassification[] = [
  "high_confidence_seed",
  "evidence_supported_seed",
  "ambiguous_seed",
  "no_candidate",
  "manual_review_required",
];

function countClassifications(
  entries: IdentitySeedEntry[],
): Record<IdentitySeedClassification, number> {
  const counts: Record<IdentitySeedClassification, number> = {
    ambiguous_seed: 0,
    evidence_supported_seed: 0,
    high_confidence_seed: 0,
    manual_review_required: 0,
    no_candidate: 0,
  };
  for (const entry of entries) counts[entry.classification] += 1;
  return counts;
}

function watchlistHash(entries: IdentitySeedEntry[]): string {
  return sha256(
    canonicalJson(
      entries.map((entry) => ({
        aliases: entry.aliases,
        canonicalArtistName: entry.canonicalArtistName,
        watchedArtistId: entry.watchedArtistId,
      })),
    ),
  );
}

function assertSanitizedArtifact(artifact: IdentitySeedArtifact): void {
  const forbidden = findForbiddenKey(artifact);
  if (forbidden) throw new Error(`Identity-seed artifact contains forbidden field ${forbidden}.`);
}

function findForbiddenKey(value: unknown, path = ""): string | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenKey(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    if (
      /(^|_)(raw|payload|artwork|preview|credential|token|authorization|private_key|spotify)(_|$)/.test(
        normalized,
      )
    ) {
      return path ? `${path}.${key}` : key;
    }
    const found = findForbiddenKey(child, path ? `${path}.${key}` : key);
    if (found) return found;
  }
  return undefined;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareText)
      .map((key) => [key, sortCanonical(value[key])]),
  );
}

function uniqueMap<T>(values: T[], key: (value: T) => string, label: string): Map<string, T> {
  const output = new Map<string, T>();
  for (const value of values) {
    const identity = key(value);
    if (output.has(identity)) throw new Error(`Duplicate ${label} identity ${identity}.`);
    output.set(identity, value);
  }
  return output;
}

function duplicateGroups(values: Array<{ id: string; name: string }>): string[][] {
  const groups = new Map<string, string[]>();
  for (const value of values) {
    const name = normalizeName(value.name);
    groups.set(name, [...(groups.get(name) ?? []), value.id]);
  }
  return [...groups.values()].filter((ids) => ids.length > 1);
}

function duplicateCount(values: string[]): number {
  return values.length - new Set(values).size;
}

function sumCounts(value: Record<IdentitySeedClassification, number>): number {
  return Object.values(value).reduce((total, item) => total + item, 0);
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function portablePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a string.`);
  return value;
}

function requiredStringArray(value: unknown, label: string): string[] {
  return requiredArray(value, label).map((item) => requiredString(item, label));
}

function requiredInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative integer.`);
  }
  return value;
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function requiredIntegerString(value: string | undefined, label: string): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(`${label} must be an integer.`);
  return Number(value);
}

function requiredBooleanString(value: string | undefined, label: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} must be true or false.`);
}

function requiredNumericId(value: unknown, label: string): string {
  const parsed = requiredString(value, label);
  if (!numericId(parsed)) throw new Error(`${label} must be a public numeric catalog ID.`);
  return parsed;
}

function numericId(value: string): boolean {
  return /^\d{1,30}$/.test(value);
}

function requiredUuid(value: unknown, label: string): string {
  const parsed = requiredString(value, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed)) {
    throw new Error(`${label} must be a UUID.`);
  }
  return parsed;
}

function requiredHash(value: unknown, label: string): string {
  const parsed = requiredString(value, label);
  if (!/^[0-9a-f]{64}$/.test(parsed)) throw new Error(`${label} must be a SHA-256 hash.`);
  return parsed;
}

function requiredFullCommit(value: unknown, label: string): string {
  const parsed = requiredString(value, label);
  if (!/^[0-9a-f]{40}$/.test(parsed)) throw new Error(`${label} must be a full Git commit.`);
  return parsed;
}

function isoTimestamp(value: string, label: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function requiredMatchStatus(value: unknown, label: string): "none" | "unique" | "multiple" {
  if (value === "none" || value === "unique" || value === "multiple") return value;
  throw new Error(`${label} is invalid.`);
}

function requiredConfidence(value: unknown): IdentitySeedConfidence {
  if (
    value === "high" ||
    value === "evidence_supported" ||
    value === "ambiguous" ||
    value === "unresolved"
  ) {
    return value;
  }
  throw new Error("Identity-seed confidence is invalid.");
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
