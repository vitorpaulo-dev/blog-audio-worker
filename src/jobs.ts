import type { Config } from "./config.js";
import { cleanForNarration } from "./cleaner.js";
import { parsePodcastScript } from "./opencode.js";
import { podcastScriptPrompt, speakerInstruct } from "./podcast.js";
import { RedisWriteError } from "./progress.js";
import { chunkText, generateVoice } from "./voicestudio.js";
import { uploadToPresignedUrl, voiceProfileForLanguage } from "./upload.js";
import type { AudioJobRequest, AudioLanguage, AudioProgress, AudioType } from "./types.js";

export interface SegmentInput {
  text: string;
  instruct?: string;
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

export async function processJobs(jobs: Job[], deps: JobDeps): Promise<void> {
  let started = 0;
  const limit = deps.config.concurrencyLimit;

  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (started < jobs.length) {
      const job = jobs[started++];
      if (job) {
        await processJob(job, deps);
      }
    }
  });
  await Promise.allSettled(workers);
}

async function processJob(job: Job, deps: JobDeps): Promise<void> {
  try {
    await writeStatus(job, { status: "QUEUED", progress: 0 }, deps);
    const audio = await synthesize(job, deps);
    await uploadToPresignedUrl(job.uploadUrl, audio, deps.fetchImpl);
    await writeStatus(job, { status: "READY", progress: 100 }, deps);
  } catch (error) {
    if (error instanceof RedisWriteError) {
      logFailure(job, error);
      return;
    }
    try {
      await writeStatus(job, { status: "FAILED", progress: 0, error: message(error) }, deps);
    } catch (_redisError) {
      logFailure(job, error);
    }
    logFailure(job, error);
  }
}

async function synthesize(job: Job, deps: JobDeps): Promise<Buffer> {
  await writeStatus(job, { status: "GENERATING", progress: 5 }, deps);
  const segments = await segmentInputs(job, deps);
  const voice = voiceProfileForLanguage(deps.config, job.language);

  const audioParts: Buffer[] = [];
  for (const [index, segment] of segments.entries()) {
    for (const chunk of chunkText(segment.text)) {
      audioParts.push(
        await generateVoice(
          deps.config.voiceStudioUrl,
          deps.config.voiceStudioToken,
          { text: chunk, language: job.language, voice, instruct: segment.instruct },
          deps.fetchImpl,
        ),
      );
    }
    const progress = 5 + Math.round(((index + 1) / segments.length) * 85);
    await writeStatus(job, { status: "GENERATING", progress }, deps);
  }

  return Buffer.concat(audioParts);
}

async function segmentInputs(job: Job, deps: JobDeps): Promise<SegmentInput[]> {
  if (job.type === "NARRATION") {
    return [{ text: cleanForNarration(job.content) }];
  }

  await writeStatus(job, { status: "GENERATING", progress: 15 }, deps);
  const script = parsePodcastScript(await deps.openCode.prompt(podcastScriptPrompt(job)));

  return script.map((turn) => ({
    text: turn.text,
    instruct: speakerInstruct(turn.speaker),
  }));
}

function writeStatus(job: Job, progress: AudioProgress, deps: JobDeps): Promise<void> {
  return deps.progressStore.write(job.postId, job.type, job.language, progress);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logFailure(job: Job, error: unknown): void {
  console.error(`Artifact ${job.type}/${job.language} for post ${job.postId} failed:`, message(error));
}
