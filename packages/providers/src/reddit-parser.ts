import { normalizeText, type ArtistCreditInput, type ReleaseType } from "@radar/core";
import { isIP } from "node:net";
import { createHash } from "node:crypto";

export const REDDIT_PARSER_VERSION = "reddit-deterministic-v1";
export const MAX_REDDIT_DOCUMENT_LENGTH = 50_000;
export const MAX_REDDIT_LINE_LENGTH = 1_000;
export const MAX_REDDIT_ROUNDUP_LINES = 250;

export type RedditCandidateClassification =
  | "TRACK"
  | "SINGLE"
  | "EP"
  | "ALBUM"
  | "REMIX"
  | "LIVE_RECORDING"
  | "COMPILATION"
  | "DJ_MIX"
  | "RADIO_SHOW"
  | "PODCAST"
  | "PLAYLIST"
  | "UNKNOWN";

export type RedditLinkCategory =
  | "spotify_track"
  | "spotify_album"
  | "spotify_playlist"
  | "soundcloud"
  | "youtube"
  | "bandcamp"
  | "beatport"
  | "musicbrainz"
  | "label_store"
  | "other";

export interface RedditExtractedLink {
  category: RedditLinkCategory;
  normalizedUrl: string;
  originalUrl: string;
  verified: false;
}

export interface RedditDateEvidence {
  confidence: "high" | "review";
  date?: string;
  sourceText: string;
}

export interface RedditParsedCandidate {
  artistText: string;
  artists: string[];
  classification: RedditCandidateClassification;
  credits: ArtistCreditInput[];
  dateEvidence?: RedditDateEvidence;
  failureReasons: string[];
  label?: string;
  links: RedditExtractedLink[];
  parseConfidence: number;
  parseReasons: string[];
  parserVersion: string;
  sectionHeading?: string;
  sourceLine?: number;
  title: string;
  version?: string;
}

export interface CanonicalArtistReference {
  aliases?: string[];
  id: string;
  musicbrainzNames?: string[];
  name: string;
  spotifyNames?: string[];
}

export interface RedditArtistMatch {
  artistId?: string;
  confidence: number;
  kind: "exact_canonical" | "exact_alias" | "exact_provider" | "review" | "none";
  reasons: string[];
}

const PREFIX_PATTERN = /^(?:\[(?:fresh|new(?:\s+music)?|premiere)\]|new\s+chune:)\s*/i;
const TITLE_SEPARATOR_PATTERN = /\s+(?:-|\u2013|\u2014)\s+/u;
const FEATURE_PATTERN = /\s+(?:feat\.?|ft\.?)\s+(.+)$/i;
const LABEL_PATTERN = /\s*\[([^\]\r\n]{1,100})\]\s*$/;
const VERSION_PATTERNS: Array<[RegExp, string]> = [
  [/\(([^()]{1,100}\s+remix)\)/i, "remix"],
  [/\bVIP\b/i, "VIP"],
  [/\bbootleg\b/i, "Bootleg"],
  [/\bmashup\b/i, "Mashup"],
  [/\bradio\s+edit\b/i, "Radio Edit"],
  [/\bextended\s+mix\b/i, "Extended Mix"],
  [/\blive(?:\s+at|\s+from|\s+version)?\b/i, "Live"],
  [/\bedit\b/i, "Edit"],
];

export function validateSubredditName(
  value: string,
): { valid: true; normalized: string } | { valid: false; error: string } {
  const name = value.trim().replace(/^r\//i, "");
  if (!name) return { valid: false, error: "Enter a subreddit name." };
  if (!/^[A-Za-z0-9_]{3,21}$/.test(name)) {
    return {
      valid: false,
      error: "Use 3 to 21 letters, numbers, or underscores without r/.",
    };
  }
  return { valid: true, normalized: name };
}

export function validateRedditEvidenceUrl(
  value: string,
): { valid: true; link: RedditExtractedLink } | { valid: false; error: string } {
  const originalUrl = value.trim().replace(/[),.;]+$/, "");
  let url: URL;
  try {
    url = new URL(originalUrl);
  } catch {
    return { valid: false, error: "The outbound URL is malformed." };
  }
  if (url.protocol !== "https:") {
    return { valid: false, error: "Outbound evidence links must use HTTPS." };
  }
  if (url.username || url.password) {
    return { valid: false, error: "Outbound evidence links cannot contain credentials." };
  }
  const host = url.hostname.toLowerCase();
  const ipCandidate = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.startsWith("xn--") ||
    host.split(".").some((label) => label.startsWith("xn--")) ||
    isIP(ipCandidate) !== 0
  ) {
    return { valid: false, error: "The outbound host is not allowed." };
  }
  url.hash = "";
  const category = categorizeUrl(url);
  if (category.startsWith("spotify_")) {
    url.search = "";
  }
  return {
    valid: true,
    link: { category, normalizedUrl: url.toString(), originalUrl, verified: false },
  };
}

export function parseRedditTitle(
  input: string,
  options: { links?: RedditExtractedLink[]; sectionHeading?: string; sourceLine?: number } = {},
): RedditParsedCandidate | undefined {
  const bounded = input.normalize("NFKC").slice(0, MAX_REDDIT_LINE_LENGTH).trim();
  if (!bounded) return undefined;
  const withoutMarkdown = stripInlineMarkdown(bounded);
  const prefixed = PREFIX_PATTERN.test(withoutMarkdown);
  const cleaned = withoutMarkdown.replace(PREFIX_PATTERN, "").trim();
  const separator = TITLE_SEPARATOR_PATTERN.exec(cleaned);
  if (!separator?.index) return undefined;

  const artistText = cleaned.slice(0, separator.index).trim();
  let titleText = cleaned.slice(separator.index + separator[0].length).trim();
  if (!artistText || !titleText || artistText.length > 300) return undefined;

  const labelMatch = LABEL_PATTERN.exec(titleText);
  const label = labelMatch?.[1]?.trim();
  if (labelMatch) titleText = titleText.slice(0, labelMatch.index).trim();

  const featuredMatch = FEATURE_PATTERN.exec(titleText);
  const featuredArtists = featuredMatch?.[1] ? splitArtistNames(featuredMatch[1]) : [];
  if (featuredMatch) titleText = titleText.slice(0, featuredMatch.index).trim();

  const artists = splitArtistNames(artistText);
  if (artists.length === 0 || !titleText) return undefined;
  const version = detectVersion(titleText);
  const classification = classifyCandidate(titleText, version, options.links ?? []);
  const parseReasons = [
    "recognized artist-title separator",
    ...(prefixed ? ["recognized release prefix"] : []),
    ...(label ? ["extracted label marker"] : []),
    ...(version ? [`preserved version marker: ${version}`] : []),
    ...(featuredArtists.length > 0 ? ["extracted featured artist credits"] : []),
  ];
  const credits: ArtistCreditInput[] = [
    ...artists.map((name) => ({ name, role: "primary" as const })),
    ...featuredArtists.map((name) => ({ name, role: "featured" as const })),
  ];
  const dateEvidence = parseExplicitRedditDate(bounded);
  const confidence = Math.min(
    1,
    0.7 + (prefixed ? 0.05 : 0) + (version ? 0.05 : 0) + (options.links?.length ? 0.1 : 0),
  );
  return {
    artistText,
    artists,
    classification,
    credits,
    ...(dateEvidence ? { dateEvidence } : {}),
    failureReasons: [],
    ...(label ? { label } : {}),
    links: options.links ?? [],
    parseConfidence: confidence,
    parseReasons,
    parserVersion: REDDIT_PARSER_VERSION,
    ...(options.sectionHeading ? { sectionHeading: options.sectionHeading } : {}),
    ...(options.sourceLine !== undefined ? { sourceLine: options.sourceLine } : {}),
    title: titleText,
    ...(version ? { version } : {}),
  };
}

export function parseRedditRoundup(markdown: string): RedditParsedCandidate[] {
  const document = markdown.slice(0, MAX_REDDIT_DOCUMENT_LENGTH).replace(/\r\n?/g, "\n");
  const lines = document.split("\n").slice(0, MAX_REDDIT_ROUNDUP_LINES);
  const candidates: RedditParsedCandidate[] = [];
  let sectionHeading: string | undefined;
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.slice(0, MAX_REDDIT_LINE_LENGTH).trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.{1,120})$/.exec(line);
    if (heading?.[1]) {
      sectionHeading = stripInlineMarkdown(heading[1]).trim();
      continue;
    }
    const likelyListLine = line.replace(/^\s*(?:[-*+]\s+|\d{1,3}[.)]\s+)/, "");
    const links = extractRedditLinks(likelyListLine);
    const text = likelyListLine
      .replace(/\[([^\]]{1,120})\]\(https?:\/\/[^\s)]+\)/g, "$1")
      .split("|")[0]
      ?.trim();
    if (!text) continue;
    const parsed = parseRedditTitle(text, {
      links,
      ...(sectionHeading ? { sectionHeading } : {}),
      sourceLine: index + 1,
    });
    if (parsed) candidates.push(parsed);
  }
  return candidates;
}

export function extractRedditLinks(input: string): RedditExtractedLink[] {
  const bounded = input.slice(0, MAX_REDDIT_DOCUMENT_LENGTH);
  const values = new Set<string>();
  const markdownPattern = /\[[^\]\r\n]{0,120}\]\((https:\/\/[^\s)]+)\)/g;
  const barePattern = /https:\/\/[^\s<>{}\u005b\u005d"']+/g;
  for (const match of bounded.matchAll(markdownPattern)) {
    if (match[1]) values.add(match[1]);
  }
  for (const match of bounded.matchAll(barePattern)) {
    if (match[0]) values.add(match[0]);
  }
  const links = [...values]
    .map((value) => validateRedditEvidenceUrl(value))
    .filter((result): result is { valid: true; link: RedditExtractedLink } => result.valid)
    .map((result) => result.link);
  return [...new Map(links.map((link) => [link.normalizedUrl, link])).values()];
}

export function parseExplicitRedditDate(
  input: string,
  referenceYear = new Date().getUTCFullYear(),
): RedditDateEvidence | undefined {
  const bounded = input.slice(0, MAX_REDDIT_LINE_LENGTH);
  const iso = /\b(?:releases?|out|release\s+date:)\s*(\d{4})-(\d{2})-(\d{2})\b/i.exec(bounded);
  if (iso?.[1] && iso[2] && iso[3]) {
    const date = validIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return date
      ? { confidence: "high", date, sourceText: iso[0] }
      : { confidence: "review", sourceText: iso[0] };
  }
  const numeric = /\b(?:coming|out|release\s+date:)\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i.exec(
    bounded,
  );
  if (numeric?.[1] && numeric[2] && numeric[3]) {
    return { confidence: "review", sourceText: numeric[0] };
  }
  const monthNames =
    "January|February|March|April|May|June|July|August|September|October|November|December";
  const named = new RegExp(
    `\\b(?:releases?|out|release\\s+date:)\\s*(${monthNames})\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?\\b`,
    "i",
  ).exec(bounded);
  if (named?.[1] && named[2]) {
    const month = monthNumber(named[1]);
    const date = validIsoDate(Number(named[3] ?? referenceYear), month, Number(named[2]));
    return date
      ? { confidence: "high", date, sourceText: named[0] }
      : { confidence: "review", sourceText: named[0] };
  }
  const relative = /\b(?:this\s+friday|next\s+month|soon)\b/i.exec(bounded);
  return relative ? { confidence: "review", sourceText: relative[0] } : undefined;
}

export function matchRedditArtist(
  artistText: string,
  watchlist: CanonicalArtistReference[],
): RedditArtistMatch {
  const normalized = normalizeText(artistText);
  if (!normalized) return { confidence: 0, kind: "none", reasons: ["empty artist text"] };
  for (const artist of watchlist) {
    if (normalizeText(artist.name) === normalized) {
      if (isAmbiguousShortName(normalized)) {
        return {
          artistId: artist.id,
          confidence: 0.5,
          kind: "review",
          reasons: ["exact canonical name is too short or common for automatic matching"],
        };
      }
      return {
        artistId: artist.id,
        confidence: 1,
        kind: "exact_canonical",
        reasons: ["exact normalized canonical artist name"],
      };
    }
    if (artist.aliases?.some((alias) => normalizeText(alias) === normalized)) {
      return {
        artistId: artist.id,
        confidence: 1,
        kind: "exact_alias",
        reasons: ["exact confirmed watchlist alias"],
      };
    }
    if (
      [...(artist.spotifyNames ?? []), ...(artist.musicbrainzNames ?? [])].some(
        (name) => normalizeText(name) === normalized,
      )
    ) {
      return {
        artistId: artist.id,
        confidence: 0.98,
        kind: "exact_provider",
        reasons: ["exact confirmed provider artist mapping name"],
      };
    }
  }
  const fuzzy = watchlist
    .map((artist) => ({ artist, score: tokenSimilarity(normalized, normalizeText(artist.name)) }))
    .sort((a, b) => b.score - a.score)[0];
  if (fuzzy && fuzzy.score >= 0.75) {
    return {
      artistId: fuzzy.artist.id,
      confidence: Math.min(0.79, fuzzy.score),
      kind: "review",
      reasons: ["conservative token similarity requires manual confirmation"],
    };
  }
  return { confidence: 0, kind: "none", reasons: ["no canonical watchlist match"] };
}

export function redditCandidateHash(candidate: RedditParsedCandidate): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        artistText: normalizeText(candidate.artistText),
        sourceLine: candidate.sourceLine ?? 0,
        title: normalizeText(candidate.title),
        version: candidate.version ?? "",
      }),
    )
    .digest("hex");
}

export function redditClassificationToReleaseType(
  classification: RedditCandidateClassification,
): ReleaseType {
  const mapping: Record<RedditCandidateClassification, ReleaseType> = {
    ALBUM: "album",
    COMPILATION: "compilation",
    DJ_MIX: "dj_mix",
    EP: "ep",
    LIVE_RECORDING: "live",
    PLAYLIST: "playlist",
    PODCAST: "podcast",
    RADIO_SHOW: "radio_show",
    REMIX: "remix",
    SINGLE: "single",
    TRACK: "single",
    UNKNOWN: "unknown",
  };
  return mapping[classification];
}

function categorizeUrl(url: URL): RedditLinkCategory {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.split("/").filter(Boolean);
  if (host === "open.spotify.com") {
    if (path[0] === "track" && /^[A-Za-z0-9]{10,30}$/.test(path[1] ?? "")) return "spotify_track";
    if (path[0] === "album" && /^[A-Za-z0-9]{10,30}$/.test(path[1] ?? "")) return "spotify_album";
    if (path[0] === "playlist") return "spotify_playlist";
  }
  if (host === "soundcloud.com" || host.endsWith(".soundcloud.com")) return "soundcloud";
  if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be")
    return "youtube";
  if (host === "bandcamp.com" || host.endsWith(".bandcamp.com")) return "bandcamp";
  if (host === "beatport.com" || host.endsWith(".beatport.com")) return "beatport";
  if (host === "musicbrainz.org" || host.endsWith(".musicbrainz.org")) return "musicbrainz";
  return "other";
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]{1,120})\]\(https?:\/\/[^\s)]+\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
}

function splitArtistNames(value: string): string[] {
  return value
    .split(/\s*(?:,|&|\bx\b|\/)\s*/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.length <= 150);
}

function detectVersion(title: string): string | undefined {
  for (const [pattern, fallback] of VERSION_PATTERNS) {
    const match = pattern.exec(title);
    if (match) return match[1]?.trim() ?? fallback;
  }
  return undefined;
}

function classifyCandidate(
  title: string,
  version: string | undefined,
  links: RedditExtractedLink[],
): RedditCandidateClassification {
  if (/\bpodcast\b/i.test(title)) return "PODCAST";
  if (/\bradio\s+show\b/i.test(title)) return "RADIO_SHOW";
  if (/\b(?:dj\s+)?mix\b|\bset\b/i.test(title)) return "DJ_MIX";
  if (/\bplaylist\b/i.test(title) || links.some((link) => link.category === "spotify_playlist")) {
    return "PLAYLIST";
  }
  if (/\bcompilation\b/i.test(title)) return "COMPILATION";
  if (/\b(?:LP|album)\b/i.test(title)) return "ALBUM";
  if (/\bEP\b/i.test(title)) return "EP";
  if (/\blive\b/i.test(title)) return "LIVE_RECORDING";
  if (version?.toLowerCase().includes("remix")) return "REMIX";
  if (title.length > 0) return "TRACK";
  return "UNKNOWN";
}

function monthNumber(name: string): number {
  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  return months.indexOf(name.toLowerCase()) + 1;
}

function validIsoDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return date.toISOString().slice(0, 10);
}

function isAmbiguousShortName(normalized: string): boolean {
  return normalized.length <= 2 || ["no", "it", "a"].includes(normalized);
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
}
