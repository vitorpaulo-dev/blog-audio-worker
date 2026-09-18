import { AUDIO_LANGUAGES, AUDIO_TYPES, type AudioJobRequest } from "./types.js";

export function parseAudioJobRequest(body: unknown): AudioJobRequest {
  if (typeof body !== "object" || body === null) {
    throw new Error("Request body must be a JSON object");
  }

  const raw = body as Record<string, unknown>;
  const postId = raw.postId;
  if (typeof postId !== "string" || !isUuid(postId)) {
    throw new Error("postId must be a valid UUID");
  }

  const postSlug = raw.postSlug;
  if (typeof postSlug !== "string" || postSlug.length === 0) {
    throw new Error("postSlug must be a non-empty string");
  }

  if (!Array.isArray(raw.contents) || raw.contents.length === 0) {
    throw new Error("contents must be a non-empty array");
  }

  const contents = raw.contents.map(parseContent);
  const uploads = parseUploads(raw.uploads);
  if (uploads.size === 0) {
    throw new Error("uploads must contain at least one upload URL");
  }

  for (const [, byLanguage] of uploads) {
    for (const language of byLanguage.keys()) {
      if (!contents.some((content) => content.language === language)) {
        throw new Error(`No content provided for upload language ${language}`);
      }
    }
  }

  return {
    postId,
    postSlug,
    contents,
    uploads: uploadsToRecord(uploads),
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function parseContent(raw: unknown): AudioJobRequest["contents"][number] {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Each content must be an object");
  }
  const entry = raw as Record<string, unknown>;
  const language = entry.language;
  if (typeof language !== "string" || !AUDIO_LANGUAGES.includes(language as never)) {
    throw new Error("content.language must be ENGLISH or PORTUGUESE");
  }
  if (typeof entry.title !== "string" || entry.title.length === 0) {
    throw new Error("content.title must be a non-empty string");
  }
  if (typeof entry.content !== "string" || entry.content.length === 0) {
    throw new Error("content.content must be a non-empty string");
  }
  return {
    language: language as AudioJobRequest["contents"][number]["language"],
    title: entry.title,
    content: entry.content,
  };
}

function parseUploads(raw: unknown): Map<string, Map<string, string>> {
  const uploads = new Map<string, Map<string, string>>();
  if (typeof raw !== "object" || raw === null) {
    throw new Error("uploads must be an object");
  }
  const record = raw as Record<string, unknown>;
  for (const type of AUDIO_TYPES) {
    const value = record[type];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== "object" || value === null) {
      throw new Error(`uploads.${type} must be an object`);
    }
    const byLanguage = new Map<string, string>();
    for (const language of AUDIO_LANGUAGES) {
      const url = (value as Record<string, unknown>)[language];
      if (url === undefined || url === null) {
        continue;
      }
      if (typeof url !== "string" || !isHttpUrl(url)) {
        throw new Error(`uploads.${type}.${language} must be an http(s) URL`);
      }
      byLanguage.set(language, url);
    }
    if (byLanguage.size > 0) {
      uploads.set(type, byLanguage);
    }
  }
  return uploads;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function uploadsToRecord(
  uploads: Map<string, Map<string, string>>,
): AudioJobRequest["uploads"] {
  const result: AudioJobRequest["uploads"] = {};
  for (const [type, byLanguage] of uploads) {
    const languages: Record<string, string> = {};
    for (const [language, url] of byLanguage) {
      languages[language] = url;
    }
    result[type as keyof AudioJobRequest["uploads"]] = languages;
  }
  return result;
}
