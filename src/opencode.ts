import { logEvent } from "./logger.js";

export interface OpenCodeClient {
  prompt(text: string): Promise<string>;
}

export class OpenCodeNetworkError extends Error {
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "OpenCodeNetworkError";
    this.cause = cause;
  }
}

export class OpenCodeHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "OpenCodeHttpError";
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function describeCause(error: unknown): string {
  const chain: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      const code = (current as Error & { code?: string }).code;
      const label = current instanceof DOMException ? current.name : (code ?? current.name);
      chain.push(`${label}: ${current.message}`);
      current = (current as Error).cause;
      continue;
    }
    if (typeof current === "object") {
      const entry = current as { code?: string; description?: string };
      chain.push([entry.code, entry.description].filter(Boolean).join(" ") || JSON.stringify(current));
      break;
    }
    chain.push(String(current));
    break;
  }
  return chain.join(" <- ") || "unknown fetch failure";
}

interface SessionInfo {
  id: string;
}

interface MessageResponse {
  info: unknown;
  parts: unknown[];
}

interface ModelRef {
  providerID: string;
  modelID: string;
}

function parseModel(raw: string | undefined): ModelRef | undefined {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return undefined;
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    logEvent("opencode.modelIgnored", { model: trimmed }, "warn");
    return undefined;
  }
  return { providerID: trimmed.slice(0, slashIndex), modelID: trimmed.slice(slashIndex + 1) };
}

export function sanitizeSnippet(body: string | undefined, token?: string): string {
  const text = body ?? "";
  const redacted = token && token.length > 0 ? text.replaceAll(token, "<redacted>") : text;
  const cleaned = redacted.replace(/\s+/g, " ").trim();
  return cleaned.length > 300 ? `${cleaned.slice(0, 300)}...` : cleaned;
}

export function createOpenCodeClient(
  baseUrl: string,
  options: { model?: string; token?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): OpenCodeClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const root = baseUrl.replace(/\/$/, "");
  const authHeaders: Record<string, string> = options.token ? { Authorization: `Bearer ${options.token}` } : {};
  const model = parseModel(options.model);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { ...(init.headers as Record<string, string>), ...authHeaders },
      });
    } catch (error) {
      throw new OpenCodeNetworkError(`opencode call failed (fetch): ${describeCause(error)}`, error);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new OpenCodeHttpError(
        response.status,
        `opencode ${path.split("/")[1] ?? path} call failed: ${response.status}: ${sanitizeSnippet(body, options.token)}`,
      );
    }
    return response;
  }

  return {
    async prompt(text: string): Promise<string> {
      const sessionResponse = await request("/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "blog-audio-worker" }),
      });
      const session = (await sessionResponse.json()) as SessionInfo;
      if (!session?.id) {
        throw new Error("opencode session response has no id");
      }

      const messageResponse = await request(`/session/${session.id}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parts: [{ type: "text", text }],
          ...(model ? { model } : {}),
        }),
      });
      const payload = (await messageResponse.json()) as MessageResponse;
      return extractText(payload.parts);
    },
  };
}

function extractText(parts: unknown[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (
      typeof part === "object" &&
      part !== null &&
      (part as Record<string, unknown>).type === "text"
    ) {
      const text = (part as Record<string, unknown>).text;
      if (typeof text === "string") {
        texts.push(text);
      }
    }
  }
  if (texts.length === 0) {
    throw new Error("opencode response contains no text parts");
  }
  return texts.join("\n");
}

function extractCandidateFromProse(raw: string): string {
  const cleaned = raw
    .replace(/^[\s\S]*?```(?:json)?\s*\n?/, "")
    .replace(/```[\s\S]*$/, "")
    .trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
}

export interface PodcastScriptTurn {
  speaker: "HOST" | "GUEST";
  text: string;
}

export function parsePodcastScript(raw: string): PodcastScriptTurn[] {
  const trimmed = raw.trim();
  const candidate =
    trimmed.startsWith("[")
      ? trimmed
      : extractCandidateFromProse(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error("Podcast script is not valid JSON");
  }
    if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Podcast script must be a non-empty JSON array");
  }
  return parsed.map((turn, index) => {
    if (typeof turn !== "object" || turn === null) {
      throw new Error(`Podcast script turn ${index} is not an object`);
    }
    const entry = turn as Record<string, unknown>;
    if (entry.speaker !== "HOST" && entry.speaker !== "GUEST") {
      throw new Error(`Podcast script turn ${index} speaker must be HOST or GUEST`);
    }
    if (typeof entry.text !== "string" || entry.text.trim().length === 0) {
      throw new Error(`Podcast script turn ${index} text must be a non-empty string`);
    }
    return { speaker: entry.speaker, text: entry.text.trim() };
  });
}
