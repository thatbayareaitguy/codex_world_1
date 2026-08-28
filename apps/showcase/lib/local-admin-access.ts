const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function getHostname(value: string | null): string | undefined {
  if (value === null) return undefined;
  try {
    return new URL(`http://${value}`).hostname;
  } catch {
    return undefined;
  }
}

export function isLocalGenreAdminRequest(
  headers: Headers,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (environment.SHOWCASE_GENRE_ADMIN_ENABLED !== "true") return false;
  const hostname = getHostname(headers.get("host"));
  return hostname !== undefined && loopbackHosts.has(hostname);
}

export function isLocalGenreAdminMutation(
  headers: Headers,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (!isLocalGenreAdminRequest(headers, environment)) return false;
  const origin = headers.get("origin");
  const host = headers.get("host");
  if (origin === null || host === null) return false;
  try {
    const originUrl = new URL(origin);
    return originUrl.host === host && loopbackHosts.has(originUrl.hostname);
  } catch {
    return false;
  }
}
