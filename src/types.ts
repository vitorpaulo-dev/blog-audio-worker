export type AudioType = "NARRATION" | "PODCAST";

export type AudioLanguage = "ENGLISH" | "PORTUGUESE";

export type AudioStatus = "QUEUED" | "GENERATING" | "READY" | "FAILED";

export interface AudioJobContent {
  language: AudioLanguage;
  title: string;
  content: string;
}

export interface AudioJobRequest {
  postId: string;
  postSlug: string;
  contents: AudioJobContent[];
  uploads: Partial<Record<AudioType, Partial<Record<AudioLanguage, string>>>>;
}

export interface AudioProgress {
  status: AudioStatus;
  progress: number;
  error?: string;
}

export const AUDIO_TYPES: readonly AudioType[] = ["NARRATION", "PODCAST"];
export const AUDIO_LANGUAGES: readonly AudioLanguage[] = ["ENGLISH", "PORTUGUESE"];
