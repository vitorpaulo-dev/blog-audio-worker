import { describe, expect, it } from "vitest";
import { processJobs, collectJobs, type Job, type JobDeps } from "../src/jobs.js";
import { SPEECH_MAX_INPUT, chunkText } from "../src/voicestudio.js";
import type { AudioProgress } from "../src/types.js";

const POST_ID = "d0a3f5c9-1f2b-4a1e-9b8c-7d5e3a2f1b0a";

const SCRIPT = `[
  {"speaker":"HOST","text":"Welcome to the show"},
  {"speaker":"GUEST","text":"Let me explain the details"}
]`;

interface RequestRecord {
  url: string;
  method: string;
  body: Buffer | string;
  headers: Record<string, string>;
}

interface Env {
  deps: JobDeps;
  writes: { key: string; value: AudioProgress }[];
  records: RequestRecord[];
  active: { count: number; max: number };
}

function makeDeps(
  options: { failUrls?: string[]; promptError?: Error; redisFailKeys?: string[] } = {},
): Env {
  const writes: { key: string; value: AudioProgress }[] = [];
  const records: RequestRecord[] = [];
  const active = { count: 0, max: 0 };

  const progressStore = {
    async write(postId: string, type: string, language: string, progress: AudioProgress) {
      const key = `${postId}:${type}:${language}`;
      writes.push({ key, value: progress });
      if (options.redisFailKeys?.includes(key)) {
        throw new Error("Redis connection lost");
      }
    },
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = (init?.body ?? "") as Buffer | string;
    const headers = flattenHeaders(init?.headers);
    records.push({ url, method, body, headers });

    active.count++;
    active.max = Math.max(active.max, active.count);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active.count--;

    if (options.failUrls?.includes(url)) {
      return new Response("upstream exploded", { status: 500 });
    }

    if (url.endsWith("/v1/audio/speech")) {
      return new Response(new Uint8Array(Buffer.from("mp3-audio-bytes")), { status: 200 });
    }

    return new Response(null, { status: 200 });
  };

  const deps: JobDeps = {
    config: {
      port: 3901,
      opencodeUrl: "http://opencode",
      voiceStudioUrl: "http://voicestudio",
      voiceStudioToken: "studio-token",
      redisUrl: "redis://localhost:6379",
      profileId: { ENGLISH: "en-voice", PORTUGUESE: "pt-voice" },
      concurrencyLimit: 2,
      redisTtlSeconds: 100,
    },
    progressStore,
    openCode: {
      prompt: async () => {
        if (options.promptError) {
          throw options.promptError;
        }
        return SCRIPT;
      },
    },
    fetchImpl,
  };

  return { deps, writes, records, active };
}

function flattenHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (headers instanceof Headers) {
    for (const [name, value] of headers.entries()) {
      result[name] = value;
    }
    return result;
  }
  return Object.assign(result, headers) as Record<string, string>;
}

function job(partial: Partial<Job>): Job {
  return {
    postId: POST_ID,
    postSlug: "my-post",
    type: "NARRATION",
    language: "ENGLISH",
    title: "My Post",
    content: "Intro text.\n\n```java\nsecret code never read aloud\n```",
    uploadUrl: "http://r2/uploads/audio.mp3",
    ...partial,
  };
}

describe("collectJobs", () => {
  it("expands the uploads map into per-artifact jobs", () => {
    const jobs = collectJobs({
      postId: POST_ID,
      postSlug: "my-post",
      contents: [
        { language: "ENGLISH", title: "T", content: "C" },
        { language: "PORTUGUESE", title: "P", content: "Q" },
      ],
      uploads: {
        NARRATION: { ENGLISH: "http://r2/n-en", PORTUGUESE: "http://r2/n-pt" },
        PODCAST: { ENGLISH: "http://r2/p-en", PORTUGUESE: "http://r2/p-pt" },
      },
    });
    expect(jobs).toHaveLength(4);
    const pairs = jobs.map((j) => `${j.type}:${j.language}`).sort();
    expect(pairs).toEqual(
      ["NARRATION:ENGLISH", "NARRATION:PORTUGUESE", "PODCAST:ENGLISH", "PODCAST:PORTUGUESE"].sort(),
    );
  });

  it("supports the single-artifact retry payload", () => {
    const jobs = collectJobs({
      postId: POST_ID,
      postSlug: "my-post",
      contents: [{ language: "ENGLISH", title: "T", content: "C" }],
      uploads: { NARRATION: { ENGLISH: "http://r2/n-en" } },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.type).toBe("NARRATION");
    expect(jobs[0]?.language).toBe("ENGLISH");
  });
});

describe("processJobs", () => {
  it("runs a narration job: cleaned text to VoiceStudio speech, PUT upload, READY status", async () => {
    const { deps, writes, records } = makeDeps();
    await processJobs([job({})], deps);

    const speech = records.find((r) => r.url.endsWith("/v1/audio/speech"));
    expect(speech?.method).toBe("POST");
    expect(speech?.headers["Content-Type"]).toBe("application/json");
    expect(speech?.headers["Authorization"]).toBe("Bearer studio-token");

    const request = encodeSpeechBody(String(speech?.body ?? ""));
    expect(request.input).toContain("Intro text.");
    expect(request.input).not.toContain("never read aloud");
    expect(request.model).toBe("omnivoice");
    expect(request.voice).toBe("en-voice");
    expect(request.response_format).toBe("mp3");
    expect(request.language).toBe("en");

    const upload = records.find((r) => r.url.startsWith("http://r2"));
    expect(upload?.method).toBe("PUT");
    expect(upload?.headers["Content-Type"]).toBe("audio/mpeg");
    expect(Buffer.from(upload?.body as Buffer).toString()).toBe("mp3-audio-bytes");

    const statuses = writes.map((w) => [w.value.status, w.value.progress]);
    expect(statuses[0]).toEqual(["QUEUED", 0]);
    expect(statuses.at(-1)).toEqual(["READY", 100]);
    expect(statuses.some(([status, progress]) => status === "GENERATING" && (progress as number) >= 30)).toBe(true);
  });

  it("writes Redis keys in the exact {postId}:{type}:{language} format", async () => {
    const { deps, writes } = makeDeps();
    await processJobs([job({ type: "PODCAST", language: "PORTUGUESE" })], deps);
    expect(writes.every((w) => w.key === `${POST_ID}:PODCAST:PORTUGUESE`)).toBe(true);
  });

  it("runs a podcast job: script prompt then per-turn synthesis with speaker instruct and concat", async () => {
    const { deps, records, writes } = makeDeps();
    await processJobs([job({ type: "PODCAST", uploadUrl: "http://r2/podcast.mp3" })], deps);

    const speeches = records.filter((r) => r.url.endsWith("/v1/audio/speech"));
    expect(speeches).toHaveLength(2);

    const first = encodeSpeechBody(String(speeches[0]?.body ?? ""));
    const second = encodeSpeechBody(String(speeches[1]?.body ?? ""));
    expect(first.instruct).toContain("energetic");
    expect(first.language).toBe("en");
    expect(second.instruct).toContain("technical");

    const upload = records.find((r) => r.url.startsWith("http://r2"));
    expect(Buffer.from(upload?.body as Buffer).toString()).toBe("mp3-audio-bytesmp3-audio-bytes");
    expect(writes.at(-1)?.value.status).toBe("READY");
  });

  it("splits narration longer than the 4096 char limit into chunked speech calls", async () => {
    const { deps, records } = makeDeps();
    const sentence = "This is a sentence about audio generation pipelines for the blog. ";
    const longContent = sentence.repeat(200);
    await processJobs([job({ content: longContent })], deps);

    const expectedChunks = chunkText(longContent);
    expect(expectedChunks.length).toBeGreaterThan(1);
    const speeches = records.filter((r) => r.url.endsWith("/v1/audio/speech"));
    expect(speeches).toHaveLength(expectedChunks.length);

    const requestBody = String(speeches[0]?.body ?? "");
    expect(requestBody.length).toBeLessThan(5000);
  });

  it("isolates a failed artifact: FAILED with error, others still READY", async () => {
    const { deps, writes } = makeDeps({ failUrls: ["http://r2/bad-en.mp3"] });
    await processJobs(
      [
        job({ uploadUrl: "http://r2/bad-en.mp3", language: "ENGLISH" }),
        job({ uploadUrl: "http://r2/good-pt.mp3", language: "PORTUGUESE" }),
      ],
      deps,
    );

    const failed = writes.filter((w) => w.key === `${POST_ID}:NARRATION:ENGLISH`);
    expect(failed.at(-1)?.value.status).toBe("FAILED");
    expect(failed.at(-1)?.value.error).toContain("Upload to presigned URL failed");

    const ready = writes.filter((w) => w.key === `${POST_ID}:NARRATION:PORTUGUESE`);
    expect(ready.at(-1)?.value.status).toBe("READY");
  });

  it("marks FAILED when the LLM script cannot be produced", async () => {
    const { deps, writes } = makeDeps({ promptError: new Error("opencode unreachable") });
    await processJobs([job({ type: "PODCAST" })], deps);
    expect(writes.at(-1)?.value.status).toBe("FAILED");
    expect(writes.at(-1)?.value.error).toBe("opencode unreachable");
  });

  it("keeps processing other jobs when a Redis write fails", async () => {
    const { deps, writes } = makeDeps({ redisFailKeys: [`${POST_ID}:NARRATION:ENGLISH`] });
    await processJobs(
      [
        job({ uploadUrl: "http://r2/audio-en.mp3" }),
        job({ language: "PORTUGUESE", uploadUrl: "http://r2/audio-pt.mp3" }),
      ],
      deps,
    );
    expect(writes.at(-1)?.key).toBe(`${POST_ID}:NARRATION:PORTUGUESE`);
    expect(writes.at(-1)?.value.status).toBe("READY");
    const enWrites = writes.filter((w) => w.key === `${POST_ID}:NARRATION:ENGLISH`);
    expect(enWrites.at(-1)?.value.status).not.toBe("READY");
  });

  it("limits concurrency to a maximum of 2 parallel jobs", async () => {
    const { deps, active } = makeDeps();
    const jobs = [1, 2, 3, 4].map((n) =>
      job({
        language: n < 3 ? "ENGLISH" : "PORTUGUESE",
        uploadUrl: `http://r2/u${n}.mp3`,
      }),
    );
    await processJobs(jobs, deps);
    expect(active.max).toBe(2);
  });

  it("uses max 4096 chars per chunk limit", () => {
    expect(SPEECH_MAX_INPUT).toBe(4096);
    expect(chunkText("short")).toEqual(["short"]);
    expect(chunkText("").every((chunk) => chunk.length <= 4096)).toBe(true);
  });
});

function encodeSpeechBody(body: string): {
  model: string;
  input: string;
  voice: string;
  response_format: string;
  language: string;
  instruct?: string;
} {
  return JSON.parse(body);
}
