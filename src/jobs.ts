import { resolveVoiceProfile, VoiceProfileMissingError, type Config, type VoiceRole } from "./config.js";
import { cleanForNarration, cleanPodcastTurnText } from "./cleaner.js";
import { OpenCodeHttpError, OpenCodeNetworkError, parsePodcastScript } from "./opencode.js";
import { podcastScriptPrompt } from "./podcast.js";
import {
  chunkText,
  generateVoice,
  VoiceStudioHttpError,
  VoiceStudioNetworkError,
} from "./voicestudio.js";
import { uploadToPresignedUrl } from "./upload.js";
import { createSingleFlightQueue } from "./queue.js";
import { logEvent, sanitizeUrl } from "./logger.js";
import type { AudioJobRequest, AudioLanguage, AudioProgress, AudioType } from "./types.js";

export interface SegmentInput {
  text: string;
  speaker?: VoiceRole;
}

export interface JobDeps {
  config: Config;
  progressStore: {
    write(postId: string, type: string, language: string, progress: AudioProgress): Promise<void>;
  };
  openCode: { prompt(text: string): Promise<string> };
  fetchImpl: typeof fetch;
}

export interface Job {
  postId: string;
  postSlug: string;
  type: AudioType;
  language: AudioLanguage;
  title: string;
  content: string;
  uploadUrl: string;
}

export interface JobOutcome {
  artifact: string;
  status: "READY" | "FAILED";
  error?: string;
}

export function collectJobs(request: AudioJobRequest): Job[] {
  const jobs: Job[] = [];
  for (const [type, byLanguage] of Object.entries(request.uploads) as [AudioType, Record<string, string>][]) {
    if (!byLanguage) {
      continue;
    }
    for (const [language, uploadUrl] of Object.entries(byLanguage)) {
      const content = request.contents.find((entry) => entry.language === language);
      if (!content) {
        continue;
      }
      jobs.push({
        postId: request.postId,
        postSlug: request.postSlug,
        type,
        language: language as AudioLanguage,
        title: content.title,
        content: content.content,
        uploadUrl,
      });
    }
  }
  return jobs;
}

export async function processJobs(jobs: Job[], deps: JobDeps): Promise<JobOutcome[]> {
  let started = 0;
  const limit = deps.config.concurrencyLimit;
  const outcomes: JobOutcome[] = [];

  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (started < jobs.length) {
      const job = jobs[started++];
      if (job) {
        outcomes.push(await processJob(job, deps));
      }
    }
  });
  await Promise.allSettled(workers);
  logDispatchSummary(jobs, outcomes);
  return outcomes;
}

function logDispatchSummary(jobs: Job[], outcomes: JobOutcome[]): void {
  const failed = outcomes.filter((outcome) => outcome.status === "FAILED");
  logEvent(
    "dispatch.summary",
    {
      postId: jobs[0]?.postId,
      artifacts: outcomes.map((outcome) => ({
        artifact: outcome.artifact,
        status: outcome.status,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      })),
      ready: outcomes.length - failed.length,
      failed: failed.length,
    },
    failed.length > 0 ? "warn" : "info",
  );
}

async function processJob(job: Job, deps: JobDeps): Promise<JobOutcome> {
  const artifact = `${job.type}:${job.language}`;
  try {
    await writeStatus(job, { status: "QUEUED", progress: 0 }, deps);
    const audio = await synthesize(job, deps);
    await upload(job, audio, deps);
    await writeStatus(job, { status: "READY", progress: 100 }, deps);
    logEvent("artifact.completed", { postId: job.postId, artifact });
    return { artifact, status: "READY" };
  } catch (error) {
    const detail = message(error);
    let redisNote: string | undefined;
    try {
      await deps.progressStore.write(job.postId, job.type, job.language, {
        status: "FAILED",
        progress: 0,
        error: detail,
      });
    } catch (redisError) {
      redisNote = `unavailable (${message(redisError)})`;
    }
    logEvent(
      "artifact.failed",
      {
        postId: job.postId,
        artifact,
        error: detail,
        ...(error instanceof VoiceProfileMissingError ? { reason: "voiceMissing" } : {}),
        ...(redisNote !== undefined ? { redis: redisNote } : {}),
      },
      "error",
    );
    return { artifact, status: "FAILED", error: detail };
  }
}

async function synthesize(job: Job, deps: JobDeps): Promise<Buffer> {
  const artifact = `${job.type}:${job.language}`;
  await writeStatus(job, { status: "GENERATING", progress: 5 }, deps);
  const segments = await segmentInputs(job, deps);

  const startedAt = Date.now();
  console.log("DBG synthesize segments", segments.length, JSON.stringify(segments));
  logEvent("synthesis.start", { postId: job.postId, artifact, segments: segments.length });

  const audioParts: Buffer[] = [];
  for (const [index, segment] of segments.entries()) {
    const role = segment.speaker ?? "HOST";
    const voice = resolveVoiceProfile(deps.config.voiceProfiles, role, job.language);
    const chunks = chunkText(segment.text);
    const segmentStartedAt = Date.now();
    logEvent("segment.start", { artifact, segment: index + 1, role, voice, chars: segment.text.length, chunks: chunks.length });
    for (const chunk of chunks) {
      audioParts.push(
        await synthesizeChunkWithRetry(deps, { text: chunk, language: job.language, voice }, artifact),
      );
    }
    logEvent("segment.end", { artifact, segment: index + 1, role, voice, durationMs: Date.now() - segmentStartedAt });
    const progress = 5 + Math.round(((index + 1) / segments.length) * 85);
    await writeStatus(job, { status: "GENERATING", progress }, deps);
  }

  logEvent("synthesis.end", { artifact, segments: segments.length, durationMs: Date.now() - startedAt });
  console.log("DBG synth done", audioParts.length, Buffer.concat(audioParts).length);
  return Buffer.concat(audioParts);
}

async function synthesizeChunkWithRetry(
  deps: JobDeps,
  input: { text: string; language: string; voice: string },
  artifact: string,
): Promise<Buffer> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await generateVoice(deps.config.voiceStudioUrl, deps.config.voiceStudioToken, input, deps.fetchImpl);
    } catch (error) {
      if (attempt === 1 && isRetryableSynthesisFailure(error)) {
        logEvent("synthesis.retry", { artifact, attempt: 2, reason: message(error) }, "warn");
        continue;
      }
      throw error;
    }
  }
}

function isRetryableSynthesisFailure(error: unknown): boolean {
  return (
    error instanceof VoiceStudioNetworkError ||
    (error instanceof VoiceStudioHttpError && (error.status >= 500 || error.status === 429))
  );
}

const scriptPromptQueue = createSingleFlightQueue();

async function upload(job: Job, audio: Buffer, deps: JobDeps): Promise<void> {
  const artifact = `${job.type}:${job.language}`;
  const startedAt = Date.now();
  logEvent("upload.start", { postId: job.postId, artifact, bytes: audio.length, uploadUrl: sanitizeUrl(job.uploadUrl) });
  await uploadToPresignedUrl(job.uploadUrl, audio, deps.fetchImpl);
  logEvent("upload.end", { artifact, durationMs: Date.now() - startedAt });
}

async function segmentInputs(job: Job, deps: JobDeps): Promise<SegmentInput[]> {
  if (job.type === "NARRATION") {
    return [{ text: cleanForNarration(job.content) }];
  }

  await writeStatus(job, { status: "GENERATING", progress: 15 }, deps);
  const artifact = `${job.type}:${job.language}`;
  const startedAt = Date.now();
  logEvent("script.start", { postId: job.postId, artifact });
  const prompt = podcastScriptPrompt(job);
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const raw = await scriptPromptQueue.enqueue((waitedMs) => {
        if (waitedMs > 0) {
          logEvent("script.queued", { postId: job.postId, artifact, waitedMs });
        }
        return deps.openCode.prompt(prompt);
      });
      const script = parsePodcastScript(raw);
      logEvent("script.end", { artifact, turns: script.length, durationMs: Date.now() - startedAt });
      return script.map((turn, index) => {
        const text = cleanPodcastTurnText(turn.text);
        if (text.length === 0) {
          throw new Error(`Podcast script turn ${index} is empty after markdown cleaning`);
        }
        return { text, speaker: turn.speaker };
      });
    } catch (error) {
      if (attempt === 1 && isRetryableScriptFailure(error)) {
        logEvent(
          "script.retry",
          { postId: job.postId, artifact, attempt: 2, reason: message(error) },
          "warn",
        );
        continue;
      }
      throw error;
    }
  }
}

function isRetryableScriptFailure(error: unknown): boolean {
  return (
    error instanceof OpenCodeNetworkError ||
    (error instanceof OpenCodeHttpError && error.status >= 500)
  );
}

async function writeStatus(job: Job, progress: AudioProgress, deps: JobDeps): Promise<void> {
  try {
    await deps.progressStore.write(job.postId, job.type, job.language, progress);
  } catch (error) {
    logEvent(
      "redis.writeFailed",
      {
        postId: job.postId,
        artifact: `${job.type}:${job.language}`,
        status: progress.status,
        redis: "unavailable",
        error: message(error),
      },
      "warn",
    );
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
