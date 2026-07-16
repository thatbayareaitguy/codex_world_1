const VERSION_MARKERS = [
  "remix",
  "live",
  "radio edit",
  "extended mix",
  "clean",
  "explicit",
  "demo",
  "acoustic",
  "instrumental",
  "remaster",
] as const;

export function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeIdentifier(value: string): string {
  return value.toLocaleUpperCase("en-US").replace(/[^A-Z0-9]/g, "");
}

export function extractVersion(value: string): string | undefined {
  const normalized = normalizeText(value);
  return VERSION_MARKERS.find((marker) => normalized.includes(marker));
}

export function normalizedCredits(credits: ReadonlyArray<{ name: string; role: string }>): string {
  return credits.map((credit) => `${credit.role}:${normalizeText(credit.name)}`).join("|");
}
