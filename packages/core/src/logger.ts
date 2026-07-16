const REDACTED_KEYS =
  /(authorization|cookie|token|secret|password|client.?secret|code|state|verifier)/i;

export type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, event: string, fields: object = {}): void {
  const redactedFields = redact(fields) as Record<string, unknown>;
  const output = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...redactedFields,
  });
  if (level === "error") console.error(output);
  else console.log(output);
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        REDACTED_KEYS.test(key) ? "[REDACTED]" : redact(child),
      ]),
    );
  }
  return value;
}
