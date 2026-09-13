import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { normalizeText } from "@radar/core";
import {
  applyVerifiedAppleIdentityDecisions,
  artistExternalIds,
  artistProviderIdentityStatuses,
  artists,
  type AppleIdentityImportDecision,
  type AppleIdentityResolutionBatchRow,
  type RadarDatabase,
  type VerifiedAppleIdentityDecision,
} from "@radar/db";
import type { AppleMusicArtist } from "@radar/providers";
import { and, eq, inArray } from "drizzle-orm";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

export const appleIdentityCsvColumns = [
  "canonical_artist_id",
  "canonical_display_name",
  "current_apple_candidate_count",
  "existing_apple_candidate_urls",
  "musicbrainz_id",
  "current_resolution_status",
  "decision",
  "apple_music_url_or_id",
  "user_note",
] as const;

export type AppleIdentityCsvRow = Record<(typeof appleIdentityCsvColumns)[number], string>;

export interface AppleIdentityVerifier {
  verify(ids: string[]): Promise<{ artists: AppleMusicArtist[]; missingIds: string[] }>;
}

export interface AppleIdentityPreviewIssue {
  artistId?: string;
  message: string;
  value?: string;
}

export interface AppleIdentityPreview {
  decisions: VerifiedAppleIdentityDecision[];
  duplicateAssignments: AppleIdentityPreviewIssue[];
  existingConflicts: AppleIdentityPreviewIssue[];
  invalidInputs: AppleIdentityPreviewIssue[];
  nameDisagreements: AppleIdentityPreviewIssue[];
  nonMappingOutcomes: number;
  unchanged: number;
  validMappings: number;
}

export function serializeAppleIdentityBatch(rows: AppleIdentityResolutionBatchRow[]): string {
  return stringify(
    rows.map((row) => ({
      apple_music_url_or_id: "",
      canonical_artist_id: row.artistId,
      canonical_display_name: row.displayName,
      current_apple_candidate_count: String(row.candidateCount),
      current_resolution_status: row.resolutionStatus,
      decision: "",
      existing_apple_candidate_urls: row.appleCandidateUrls.join(";"),
      musicbrainz_id: row.musicBrainzId ?? "",
      user_note: "",
    })),
    { header: true, columns: [...appleIdentityCsvColumns] },
  );
}

export async function writeAppleIdentityBatch(
  path: string,
  rows: AppleIdentityResolutionBatchRow[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeAppleIdentityBatch(rows), { encoding: "utf8", flag: "wx" });
}

export async function readAppleIdentityCsv(path: string): Promise<AppleIdentityCsvRow[]> {
  return parseAppleIdentityCsv(await readFile(path, "utf8"));
}

export function parseAppleIdentityCsv(contents: string): AppleIdentityCsvRow[] {
  const records: Array<Record<string, string>> = parse(contents, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
  const headers = Object.keys(records[0] ?? {});
  const missing = appleIdentityCsvColumns.filter((column) => !headers.includes(column));
  if (missing.length) throw new Error(`CSV is missing required columns: ${missing.join(", ")}`);
  return records.map((record) =>
    Object.fromEntries(appleIdentityCsvColumns.map((column) => [column, record[column] ?? ""])),
  ) as AppleIdentityCsvRow[];
}

export function parseAppleMusicArtistId(value: string): string {
  const trimmed = value.trim();
  if (/^[0-9]{1,32}$/.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Apple Music value must be a numeric artist ID or HTTPS Apple Music URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "music.apple.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw new Error("Apple Music URL is not a safe HTTPS music.apple.com artist URL.");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const artistIndex = segments.indexOf("artist");
  const id = segments.at(-1) ?? "";
  if (artistIndex < 1 || artistIndex > segments.length - 2 || !/^[0-9]{1,32}$/.test(id)) {
    throw new Error("Apple Music URL must identify an artist and end in its numeric ID.");
  }
  return id;
}

export async function previewAppleIdentityCsv(
  db: RadarDatabase,
  rows: AppleIdentityCsvRow[],
  verifier: AppleIdentityVerifier,
): Promise<AppleIdentityPreview> {
  const invalidInputs: AppleIdentityPreviewIssue[] = [];
  const duplicateAssignments: AppleIdentityPreviewIssue[] = [];
  const existingConflicts: AppleIdentityPreviewIssue[] = [];
  const nameDisagreements: AppleIdentityPreviewIssue[] = [];
  const parsed: Array<{
    artistId: string;
    canonicalName: string;
    decision: AppleIdentityImportDecision;
    ids: string[];
    suppliedValue: string;
    userNote?: string;
  }> = [];
  const seenArtists = new Set<string>();

  for (const row of rows) {
    const artistId = row.canonical_artist_id.trim();
    if (!isUuid(artistId) || seenArtists.has(artistId)) {
      invalidInputs.push({ artistId, message: "Canonical artist ID is invalid or duplicated." });
      continue;
    }
    seenArtists.add(artistId);
    const suppliedValue = row.apple_music_url_or_id.trim();
    const decisionValue = row.decision.trim().toLowerCase();
    if (!decisionValue && !suppliedValue) continue;
    const decision = parseDecision(decisionValue, suppliedValue);
    if (!decision) {
      invalidInputs.push({
        artistId,
        message: "Decision must be confirm, unavailable, split_profile, or defer.",
      });
      continue;
    }
    const ids: string[] = [];
    if (decision === "confirm" || decision === "split_profile") {
      const values = suppliedValue
        .split(";")
        .map((value) => value.trim())
        .filter(Boolean);
      try {
        ids.push(...new Set(values.map(parseAppleMusicArtistId)));
      } catch (error) {
        invalidInputs.push({
          artistId,
          message: error instanceof Error ? error.message : "Apple Music value is invalid.",
          value: suppliedValue,
        });
        continue;
      }
      if (
        (decision === "confirm" && ids.length !== 1) ||
        (decision === "split_profile" && ids.length < 2)
      ) {
        invalidInputs.push({
          artistId,
          message:
            decision === "confirm"
              ? "Confirm requires exactly one Apple artist ID."
              : "Split profile requires at least two Apple artist IDs separated by semicolons.",
        });
        continue;
      }
    } else if (suppliedValue) {
      invalidInputs.push({
        artistId,
        message: "Unavailable and deferred rows must not contain Apple IDs.",
      });
      continue;
    }
    parsed.push({
      artistId,
      canonicalName: row.canonical_display_name.trim(),
      decision,
      ids,
      suppliedValue,
      ...(row.user_note.trim() ? { userNote: row.user_note.trim() } : {}),
    });
  }

  const assignments = new Map<string, string[]>();
  for (const entry of parsed) {
    for (const id of entry.ids)
      assignments.set(id, [...(assignments.get(id) ?? []), entry.artistId]);
  }
  for (const [id, artistIds] of assignments) {
    if (new Set(artistIds).size > 1) {
      duplicateAssignments.push({
        message: "Apple artist ID is assigned to multiple canonical artists.",
        value: id,
      });
    }
  }

  const artistIds = parsed.map((entry) => entry.artistId);
  const appleIds = [...assignments.keys()];
  const [canonicalRows, statusRows, mappingRows] = await Promise.all([
    artistIds.length
      ? db
          .select({ id: artists.id, name: artists.name })
          .from(artists)
          .where(inArray(artists.id, artistIds))
      : [],
    artistIds.length
      ? db
          .select()
          .from(artistProviderIdentityStatuses)
          .where(
            and(
              eq(artistProviderIdentityStatuses.provider, "apple_music"),
              inArray(artistProviderIdentityStatuses.artistId, artistIds),
            ),
          )
      : [],
    appleIds.length
      ? db
          .select()
          .from(artistExternalIds)
          .where(
            and(
              eq(artistExternalIds.provider, "apple_music"),
              inArray(artistExternalIds.externalId, appleIds),
            ),
          )
      : [],
  ]);
  const canonicalById = new Map(canonicalRows.map((row) => [row.id, row]));
  const statusByArtist = new Map(statusRows.map((row) => [row.artistId, row]));
  for (const entry of parsed) {
    if (!canonicalById.has(entry.artistId) || !statusByArtist.has(entry.artistId)) {
      invalidInputs.push({
        artistId: entry.artistId,
        message: "Canonical artist or Apple identity state no longer exists.",
      });
    }
  }
  for (const mapping of mappingRows) {
    const assigned = assignments.get(mapping.externalId) ?? [];
    if (assigned.some((artistId) => artistId !== mapping.artistId)) {
      existingConflicts.push({
        artistId: mapping.artistId,
        message: "Apple artist ID is already mapped to another canonical artist.",
        value: mapping.externalId,
      });
    }
  }

  const verified = appleIds.length
    ? await verifier.verify(appleIds)
    : { artists: [], missingIds: [] };
  const verifiedById = new Map(verified.artists.map((artist) => [artist.artistId, artist]));
  for (const id of verified.missingIds) {
    invalidInputs.push({
      message: "Apple Music did not return an artist for the supplied ID.",
      value: id,
    });
  }
  const decisions: VerifiedAppleIdentityDecision[] = [];
  let unchanged = 0;
  for (const entry of parsed) {
    if (!canonicalById.has(entry.artistId) || !statusByArtist.has(entry.artistId)) continue;
    const appleArtists = entry.ids.map((id) => verifiedById.get(id)).filter(isPresent);
    if (appleArtists.length !== entry.ids.length) continue;
    for (const artist of appleArtists) {
      const expectedName = canonicalById.get(entry.artistId)!.name;
      if (normalizeText(expectedName) !== normalizeText(artist.name)) {
        nameDisagreements.push({
          artistId: entry.artistId,
          message: `Canonical name "${expectedName}" differs from Apple artist "${artist.name}".`,
          value: artist.artistId,
        });
      }
    }
    const current = statusByArtist.get(entry.artistId)!;
    const targetStatus = decisionStatus(entry.decision);
    const same =
      current.status === targetStatus &&
      sameStrings(current.externalIds, entry.ids) &&
      (current.userNote ?? "") === (entry.userNote ?? "");
    if (same) unchanged += 1;
    decisions.push({
      appleArtists: appleArtists.map((artist) => ({
        id: artist.artistId,
        name: artist.name,
        url: artist.evidenceUrl ?? `https://music.apple.com/us/artist/${artist.artistId}`,
      })),
      artistId: entry.artistId,
      decision: entry.decision,
      suppliedValue: entry.suppliedValue,
      ...(entry.userNote ? { userNote: entry.userNote } : {}),
    });
  }
  return {
    decisions,
    duplicateAssignments,
    existingConflicts,
    invalidInputs,
    nameDisagreements,
    nonMappingOutcomes: decisions.filter((decision) => decision.decision !== "confirm").length,
    unchanged,
    validMappings: decisions.filter((decision) => decision.decision === "confirm").length,
  };
}

export async function applyAppleIdentityPreview(
  db: RadarDatabase,
  preview: AppleIdentityPreview,
): Promise<{ applied: number; unchanged: number }> {
  if (
    preview.invalidInputs.length ||
    preview.duplicateAssignments.length ||
    preview.existingConflicts.length
  ) {
    throw new Error("Preview contains blocking validation errors; no rows were applied.");
  }
  return applyVerifiedAppleIdentityDecisions(db, preview.decisions);
}

function parseDecision(value: string, suppliedValue: string): AppleIdentityImportDecision | null {
  if (!value && suppliedValue) return "confirm";
  if (value === "confirm") return "confirm";
  if (value === "unavailable" || value === "confirmed_unavailable") return "unavailable";
  if (value === "split_profile" || value === "split") return "split_profile";
  if (value === "defer" || value === "intentionally_deferred") return "defer";
  return null;
}

function decisionStatus(decision: AppleIdentityImportDecision): string {
  if (decision === "confirm") return "manually_confirmed";
  if (decision === "split_profile") return "split_profile";
  if (decision === "defer") return "intentionally_deferred";
  return "confirmed_unavailable";
}

function sameStrings(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return [...left].sort().every((value, index) => value === sortedRight[index]);
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
