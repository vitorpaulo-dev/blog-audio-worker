export interface GenerateInput {
  text: string;
  language: AudioLanguageInput;
  voice: string;
  instruct?: string;
}

export type AudioLanguageInput = "ENGLISH" | "PORTUGUESE" | string;

export const SPEECH_MAX_INPUT = 4096;

const LANGUAGE_CODES: Record<string, string> = {
  ENGLISH: "en",
  PORTUGUESE: "pt",
};

export interface SpeechRequest {
  model: string;
  input: string;
  voice: string;
  response_format: "mp3";
  language: string;
  instruct?: string;
}

export async function generateVoice(
  baseUrl: string,
  token: string,
  input: GenerateInput,
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer> {
  const request: SpeechRequest = {
    model: "omnivoice",
    input: input.text,
    voice: input.voice,
    response_format: "mp3",
    language: mapLanguage(input.language),
    ...(input.instruct ? { instruct: input.instruct } : {}),
  };

  const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/v1/audio/speech`, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const detail = await safeText(response);
    throw new Error(`VoiceStudio /v1/audio/speech failed: ${response.status} ${detail}`);
  }

  return decodeAudio(response);
}

function buildHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function mapLanguage(language: string): string {
  return LANGUAGE_CODES[language] ?? language;
}

async function decodeAudio(response: Response): Promise<Buffer> {
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return bytes;
  }
  return audioFromJson(JSON.parse(bytes.toString("utf8")));
}

interface SpeechJsonResponse {
  audio?: string;
  audio_base64?: string;
  b64?: string;
  base64?: string;
  data?: string;
}

function audioFromJson(payload: SpeechJsonResponse): Buffer {
  const encoded = payload.audio ?? payload.audio_base64 ?? payload.b64 ?? payload.base64 ?? payload.data;
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new Error("VoiceStudio returned JSON without base64 audio content");
  }
  return Buffer.from(encoded, "base64");
}

export function chunkText(text: string, limit = SPEECH_MAX_INPUT): string[] {
  if (text.length <= limit) {
    return [text];
  }
  const sentences = text.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    for (const piece of splitLongSentence(sentence, limit)) {
      if (current.length + piece.length > limit && current.length > 0) {
        chunks.push(current.trim());
        current = "";
      }
      current += piece;
    }
  }
  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }
  return chunks;
}

function splitLongSentence(sentence: string, limit: number): string[] {
  if (sentence.length <= limit) {
    return [sentence];
  }
  const pieces: string[] = [];
  let current = "";
  for (const word of sentence.split(/(\s+)/)) {
    if (current.length + word.length > limit && current.length > 0) {
      pieces.push(current);
      current = "";
    }
    current += word;
  }
  if (current.trim().length > 0) {
    pieces.push(current);
  }
  return pieces;
}

async function safeText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 300);
  } catch {
    return "<unreadable>";
  }
}
