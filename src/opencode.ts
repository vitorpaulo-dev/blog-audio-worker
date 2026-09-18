export interface OpenCodeClient {
  prompt(text: string): Promise<string>;
}

interface SessionInfo {
  id: string;
}

interface MessageResponse {
  info: unknown;
  parts: unknown[];
}

export function createOpenCodeClient(
  baseUrl: string,
  options: { model?: string; token?: string; fetchImpl?: typeof fetch } = {},
): OpenCodeClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const root = baseUrl.replace(/\/$/, "");
  const authHeaders: Record<string, string> = options.token ? { Authorization: `Bearer ${options.token}` } : {};

  async function request(path: string, init: RequestInit): Promise<Response> {
    const response = await fetchImpl(`${root}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), ...authHeaders },
    });
    if (!response.ok) {
      throw new Error(`opencode ${path.split("/")[1] ?? path} call failed: ${response.status}`);
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
          ...(options.model ? { model: options.model } : {}),
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

export interface PodcastScriptTurn {
  speaker: "HOST" | "GUEST";
  text: string;
}

export function parsePodcastScript(raw: string): PodcastScriptTurn[] {
  const cleaned = raw
    .replace(/^[\s\S]*?```(?:json)?\s*\n?/, "")
    .replace(/```[\s\S]*$/, "")
    .trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  const candidate = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
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
