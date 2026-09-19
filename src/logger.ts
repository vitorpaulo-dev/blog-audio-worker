export type LogLevel = "info" | "warn" | "error";

export function logEvent(event: string, fields: Record<string, unknown> = {}, level: LogLevel = "info"): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
  const target = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  target(line);
}

export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}
