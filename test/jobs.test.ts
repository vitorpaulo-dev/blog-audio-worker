import { describe, expect, it, vi } from "vitest";
import { processJobs, collectJobs, type Job, type JobDeps, type JobOutcome } from "../src/jobs.js";
import { OpenCodeHttpError, OpenCodeNetworkError } from "../src/opencode.js";
import { createNoopProgressStore, type ProgressStore } from "../src/progress.js";
import { SPEECH_MAX_INPUT, chunkText } from "../src/voicestudio.js";
import type { AudioProgress } from "../src/types.js";
import type { Config } from "../src/config.js";

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
  promptCalls: string[];
  promptActive: { count: number; max: number };
  speechCalls: number;
}

function makeDeps(
  options: {
    failUrls?: string[];
    promptError?: Error;
    promptSequence?: (Error | string)[];
    promptDelayMs?: number;
    redisFailKeys?: string[];
    voiceProfiles?: Config["voiceProfiles"];
    withoutRedis?: true;
    speechResponses?: (Response | Error)[];
  } = {},
): Env {
  const writes: { key: string; value: AudioProgress }[] = [];
  const records: RequestRecord[] = [];
  const active = { count: 0, max: 0 };

  const progressStore: ProgressStore = options.withoutRedis
    ? createNoopProgressStore()
    : {
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
      speechCalls += 1;
      if (options.speechResponses) {
        const next = speechQueue.shift();
        if (next === undefined) {
          throw new Error("speech response sequence exhausted");
        }
        if (next instanceof Error) {
          throw next;
        }
        return next;
      }
      return new Response(new Uint8Array(Buffer.from("mp3-audio-bytes")), { status: 200 });
    }

    return new Response(null, { status: 200 });
  };

  const prompts: (Error | string)[] = options.promptSequence ? [...options.promptSequence] : [];
  const promptCalls: string[] = [];
  const promptActive = { count: 0, max: 0 };
  const speechQueue: (Response | Error)[] = options.speechResponses ? [...options.speechResponses] : [];
  let speechCalls = 0;

  const deps: JobDeps = {
    config: {
      port: 3901,
      opencodeUrl: "http://opencode",
      voiceStudioUrl: "http://voicestudio",
      voiceStudioToken: "studio-token",
      redisUrl: options.withoutRedis ? undefined : "redis://localhost:6379",
      voiceProfiles:
        options.voiceProfiles ?? {
          ENGLISH: { host: "en-voice", guest: "en-guest-voice" },
          PORTUGUESE: { host: "pt-voice", guest: "pt-guest-voice" },
        },
      concurrencyLimit: 2,
      redisTtlSeconds: 100,
    },
    progressStore,
    openCode: {
      prompt: async (text: string) => {
        promptCalls.push(text);
        promptActive.count += 1;
        promptActive.max = Math.max(promptActive.max, promptActive.count);
        try {
          if (options.promptDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, options.promptDelayMs));
          }
          if (options.promptSequence) {
            const next = prompts.shift();
            if (next === undefined) {
              throw new Error("prompt sequence exhausted");
            }
            if (next instanceof Error) {
              throw next;
            }
            return next;
          }
          if (options.promptError) {
            throw options.promptError;
          }
          return SCRIPT;
        } finally {
          promptActive.count -= 1;
        }
      },
    },
    fetchImpl,
  };

  return {
    deps,
    writes,
    records,
    active,
    promptCalls,
    promptActive,
    get speechCalls() {
      return speechCalls;
    },
  };
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
    expect("instruct" in request).toBe(false);

    const upload = records.find((r) => r.url.startsWith("http://r2"));
    expect(upload?.method).toBe("PUT");
    expect(upload?.headers["Content-Type"]).toBe("audio/mpeg");
    expect(Buffer.from(upload?.body as Buffer).toString()).toBe("mp3-audio-bytes");

    const statuses = writes.map((w) => [w.value.status, w.value.progress]);
    expect(statuses[0]).toEqual(["QUEUED", 0]);
    expect(statuses.at(-1)).toEqual(["READY", 100]);
    expect(statuses.some(([status, progress]) => status === "GENERATING" && (progress as number) >= 30)).toBe(true);
  });

  it("fails the narration artifact with voiceMissing when the host profile is unset", async () => {
    const { deps, records } = makeDeps({ voiceProfiles: { ENGLISH: { guest: "en-guest-only" }, PORTUGUESE: {} } });
    const outcomes = await processJobs([job({})], deps);

    expect(outcomes.map((o) => o.status)).toEqual(["FAILED"]);
    expect(outcomes[0]?.error).toContain("voiceMissing");
    expect(outcomes[0]?.error).toContain("VOICE_PROFILE_ID_ENGLISH_HOST");
    expect(records.some((r) => r.url.endsWith("/v1/audio/speech"))).toBe(false);
  });

  it("fails the artifact with voiceMissing when no profile is configured", async () => {
    const { deps, records } = makeDeps({ voiceProfiles: {} });
    const outcomes = await processJobs([job({ type: "PODCAST", uploadUrl: "http://r2/podcast.mp3" })], deps);

    expect(outcomes.map((o) => o.status)).toEqual(["FAILED"]);
    expect(outcomes[0]?.error).toContain("voiceMissing");
    expect(records.some((r) => r.url.endsWith("/v1/audio/speech"))).toBe(false);
  });

  it("fails a guest segment with voiceMissing when only the host voice is set", async () => {
    const { deps, writes } = makeDeps({
      voiceProfiles: { ENGLISH: { host: "en-host-only" }, PORTUGUESE: {} },
    });
    const outcomes = await processJobs([job({ type: "PODCAST", uploadUrl: "http://r2/podcast.mp3" })], deps);

    expect(outcomes.map((o) => o.status)).toEqual(["FAILED"]);
    expect(outcomes[0]?.error).toContain("VOICE_PROFILE_ID_ENGLISH_GUEST");
    const failures = writes.filter((w) => w.value.status === "FAILED");
    expect(failures.at(-1)?.value.error).toContain("voiceMissing");
  });

  it("reports the voiceMissing reason on artifact.failed", async () => {
    const { deps } = makeDeps({ voiceProfiles: { ENGLISH: {}, PORTUGUESE: {} } });
    const failures: string[] = [];
    const originalError = console.error;
    console.error = (line: string) => {
      failures.push(line);
    };
    try {
      await processJobs([job({})], deps);
    } finally {
      console.error = originalError;
    }
    const artifactFailed = failures
      .map((line) => {
        try {
          return JSON.parse(line) as { event?: string; reason?: string };
        } catch {
          return null;
        }
      })
      .filter((entry) => entry?.event === "artifact.failed");
    expect(artifactFailed).toHaveLength(1);
    expect(artifactFailed[0]?.reason).toBe("voiceMissing");
  });

  it("maps podcast turns to the host and guest profiles per segment", async () => {
    const { deps, records } = makeDeps({
      voiceProfiles: { ENGLISH: { host: "sky-serif", guest: "en-guest-voice" }, PORTUGUESE: {} },
    });
    await processJobs([job({ type: "PODCAST", uploadUrl: "http://r2/podcast.mp3" })], deps);

    const speeches = records.filter((r) => r.url.endsWith("/v1/audio/speech"));
    const first = encodeSpeechBody(String(speeches[0]?.body ?? ""));
    const second = encodeSpeechBody(String(speeches[1]?.body ?? ""));
    expect(first.voice).toBe("sky-serif");
    expect(second.voice).toBe("en-guest-voice");
  });

  it("writes Redis keys in the exact {postId}:{type}:{language} format", async () => {
    const { deps, writes } = makeDeps();
    await processJobs([job({ type: "PODCAST", language: "PORTUGUESE" })], deps);
    expect(writes.every((w) => w.key === `${POST_ID}:PODCAST:PORTUGUESE`)).toBe(true);
  });

  it("runs a podcast job: script prompt then per-turn synthesis without instruct and concat", async () => {
    const { deps, records, writes } = makeDeps();
    await processJobs([job({ type: "PODCAST", uploadUrl: "http://r2/podcast.mp3" })], deps);

    const speeches = records.filter((r) => r.url.endsWith("/v1/audio/speech"));
    expect(speeches).toHaveLength(2);

    const first = encodeSpeechBody(String(speeches[0]?.body ?? ""));
    const second = encodeSpeechBody(String(speeches[1]?.body ?? ""));
    expect(first.voice).toBe("en-voice");
    expect(second.voice).toBe("en-guest-voice");
    expect("instruct" in first).toBe(false);
    expect(first.language).toBe("en");
    expect("instruct" in second).toBe(false);

    const upload = records.find((r) => r.url.startsWith("http://r2"));
    expect(Buffer.from(upload?.body as Buffer).toString()).toBe("mp3-audio-bytesmp3-audio-bytes");
    expect(writes.at(-1)?.value.status).toBe("READY");
  });

  it("cleans markdown syntax from podcast script turns before synthesis, keeping the words", async () => {
    const messyScript = JSON.stringify([
      { speaker: "HOST", text: "## Welcome to **the show** — here's *today's* topic" },
      { speaker: "GUEST", text: "Run `deploy --watch` inside a ``code` snippet, quoting \"stay` focused\"" },
      { speaker: "GUEST", text: "```ts\nlet x = call(__args__)\n```\n__Deep explanation__ follows" },
    ]);
    const { deps, records } = makeDeps({
      promptSequence: [messyScript],
      voiceProfiles: { ENGLISH: { host: "en-host", guest: "en-guest" }, PORTUGUESE: {} },
    });
    await processJobs([job({ type: "PODCAST", uploadUrl: "http://r2/podcast.mp3" })], deps);

    const speeches = records.filter((r) => r.url.endsWith("/v1/audio/speech"));
    expect(speeches).toHaveLength(3);

    const first = encodeSpeechBody(String(speeches[0]?.body ?? ""));
    expect(first.input).toBe("Welcome to the show — here's today's topic");

    const second = encodeSpeechBody(String(speeches[1]?.body ?? ""));
    expect(second.input).toContain("deploy --watch");
    expect(second.input).toContain("code snippet");
    expect(second.input).toContain('"stay focused"');
    expect(second.input).not.toContain("`");

    const third = encodeSpeechBody(String(speeches[2]?.body ?? ""));
    expect(third.input).toContain("let x = call(args)");
    expect(third.input).toContain("Deep explanation follows");
    expect(third.input).not.toContain("```");
    expect(third.input).not.toContain("__");
  });

  it("fails the podcast artifact when a turn becomes empty after cleaning", async () => {
    const emptyAfterClean = JSON.stringify([
      { speaker: "HOST", text: "## Real content here" },
      { speaker: "GUEST", text: "##  " },
    ]);
    const env2 = makeDeps({ promptSequence: [emptyAfterClean] });
    const writes = env2.writes;
    const records = env2.records;
    const outcomes = await processJobs([job({ type: "PODCAST", uploadUrl: "http://r2/podcast.mp3" })], env2.deps);

    expect(outcomes.map((o) => o.status)).toEqual(["FAILED"]);
    expect(outcomes[0]?.error).toContain("empty after markdown cleaning");
    expect(writes.at(-1)?.value.status).toBe("FAILED");
    expect(records.filter((r) => r.url.endsWith("/v1/audio/speech"))).toHaveLength(0);
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

  it("retries the podcast script once on a network-level failure and succeeds on the 2nd attempt", async () => {
    const { deps, writes, promptCalls } = makeDeps({
      promptSequence: [new OpenCodeNetworkError("opencode call failed (fetch): ECONNRESET: socket hang up", null), SCRIPT],
    });
    const retried: string[] = [];
    const originalWarn = console.warn;
    console.warn = (line: string) => {
      retried.push(line);
    };
    try {
      const outcomes = await processJobs([job({ type: "PODCAST", uploadUrl: "http://r2/podcast.mp3" })], deps);
      expect(outcomes.map((o) => o.status)).toEqual(["READY"]);
    } finally {
      console.warn = originalWarn;
    }
    expect(promptCalls).toHaveLength(2);
    const scriptRetry = retried
      .map((line) => {
        try {
          return JSON.parse(line) as { event?: string; attempt?: number; artifact?: string };
        } catch {
          return null;
        }
      })
      .filter((entry) => entry?.event === "script.retry");
    expect(scriptRetry).toHaveLength(1);
    expect(scriptRetry[0]?.attempt).toBe(2);
    expect(scriptRetry[0]?.artifact).toBe("PODCAST:ENGLISH");
    expect(writes.at(-1)?.value.status).toBe("READY");
  });

  it("does not retry the script on a 4xx opencode failure", async () => {
    const { deps, writes, promptCalls } = makeDeps({
      promptSequence: [new OpenCodeHttpError(400, "opencode session call failed: 400: bad request")],
    });
    const outcomes = await processJobs([job({ type: "PODCAST" })], deps);
    expect(promptCalls).toHaveLength(1);
    expect(outcomes.map((o) => o.status)).toEqual(["FAILED"]);
    expect(outcomes[0]?.error).toContain("call failed: 400: bad request");
    expect(writes.at(-1)?.value.status).toBe("FAILED");
  });

  it("retries the script once on an opencode 5xx failure", async () => {
    const { deps, promptCalls } = makeDeps({
      promptSequence: [new OpenCodeHttpError(502, "opencode message call failed: 502: upstream"), SCRIPT],
    });
    const outcomes = await processJobs([job({ type: "PODCAST", uploadUrl: "http://r2/podcast.mp3" })], deps);
    expect(promptCalls).toHaveLength(2);
    expect(outcomes.map((o) => o.status)).toEqual(["READY"]);
  });

  it("does not retry script guidance failures like invalid JSON output", async () => {
    const { deps, promptCalls } = makeDeps({
      promptSequence: ["this is not json at all", SCRIPT],
    });
    const outcomes = await processJobs([job({ type: "PODCAST" })], deps);
    expect(promptCalls).toHaveLength(1);
    expect(outcomes.map((o) => o.status)).toEqual(["FAILED"]);
  });

  it("serializes concurrent podcast script prompts: at most one prompt in flight at any time", async () => {
    const env = makeDeps({ promptDelayMs: 15 });
    const captured: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => captured.push(line);
    const outcomes = await processJobs(
      [
        job({ type: "PODCAST", uploadUrl: "http://r2/en.mp3" }),
        job({ type: "PODCAST", language: "PORTUGUESE", uploadUrl: "http://r2/pt.mp3" }),
      ],
      env.deps,
    ).finally(() => {
      console.log = originalLog;
    });

    expect(outcomes.every((o) => o.status === "READY")).toBe(true);
    expect(promptCallsIn(env)).toBe(2);
    expect(env.promptActive.max).toBe(1);
    expect(readyWrites(env)).toEqual(["PODCAST:ENGLISH", "PODCAST:PORTUGUESE"].sort());

    const queued = captured
      .map((line) => {
        try {
          return JSON.parse(line) as { event?: string; artifact?: string; waitedMs?: number };
        } catch {
          return null;
        }
      })
      .filter((entry) => entry?.event === "script.queued");
    expect(queued.length).toBe(1);
    expect(queued[0]?.waitedMs).toBeGreaterThan(0);
    expect(["PODCAST:ENGLISH", "PODCAST:PORTUGUESE"]).toContain(queued[0]?.artifact);
  });

  it("a permanent first-prompt failure does not block the queued artifact's turn", async () => {
    const env = makeDeps({
      promptSequence: [new OpenCodeHttpError(400, "opencode call failed: 400: bad request"), SCRIPT],
    });
    const outcomes = await processJobs(
      [
        job({ type: "PODCAST", uploadUrl: "http://r2/en.mp3" }),
        job({ type: "PODCAST", language: "PORTUGUESE", uploadUrl: "http://r2/pt.mp3" }),
      ],
      env.deps,
    );

    expect(outcomes.map((o) => o.status).sort()).toEqual(["FAILED", "READY"]);
    expect(outcomes.find((o) => o.status === "FAILED")?.error).toContain("400: bad request");
    expect(outcomes.find((o) => o.status === "READY")?.artifact).not.toBe(
      outcomes.find((o) => o.status === "FAILED")?.artifact,
    );
    expect(env.promptActive.max).toBe(1);
  });

  it("retries a queued request once after the queue releases and completes READY", async () => {
    const env = makeDeps({
      promptSequence: [
        new OpenCodeNetworkError("opencode call failed (fetch): UND_ERR_HEADERS_TIMEOUT", null),
        SCRIPT,
        SCRIPT,
      ],
    });
    const captured: string[] = [];
    const originalWarn = console.warn;
    console.warn = (line: string) => captured.push(line);
    const outcomes = await processJobs(
      [
        job({ type: "PODCAST", uploadUrl: "http://r2/en.mp3" }),
        job({ type: "PODCAST", language: "PORTUGUESE", uploadUrl: "http://r2/pt.mp3" }),
      ],
      env.deps,
    ).finally(() => {
      console.warn = originalWarn;
    });

    expect(outcomes.every((o) => o.status === "READY")).toBe(true);
    expect(promptCallsIn(env)).toBe(3);
    expect(env.promptActive.max).toBe(1);
    const retries = captured
      .map((line) => {
        try {
          return JSON.parse(line) as { event?: string };
        } catch {
          return null;
        }
      })
      .filter((entry) => entry?.event === "script.retry");
    expect(retries).toHaveLength(1);
  });

  it("applies the timeout budget per queued request: a timeout failure on its own turn is retried fresh", async () => {
    const env = makeDeps({
      promptSequence: [
        new OpenCodeNetworkError("opencode call failed (fetch): AbortError: This operation was aborted", null),
        SCRIPT,
        SCRIPT,
      ],
    });
    const outcomes = await processJobs(
      [
        job({ type: "PODCAST", uploadUrl: "http://r2/en.mp3" }),
        job({ type: "PODCAST", language: "PORTUGUESE", uploadUrl: "http://r2/pt.mp3" }),
      ],
      env.deps,
    );

    expect(outcomes.every((o) => o.status === "READY")).toBe(true);
    expect(promptCallsIn(env)).toBe(3);
    expect(env.promptActive.max).toBe(1);
    expect(readyWrites(env)).toEqual(["PODCAST:ENGLISH", "PODCAST:PORTUGUESE"].sort());
  });

  function promptCallsIn(env: Env): number {
    return env.promptCalls.length;
  }

  function readyWrites(env: Env): string[] {
    return env.writes
      .filter((w) => w.value.status === "READY")
      .map((w) => w.key.split(":").slice(1).join(":"))
      .sort();
  }

  it("keeps processing other jobs when a Redis write fails and both artifacts still complete", async () => {
    const { deps, writes } = makeDeps({ redisFailKeys: [`${POST_ID}:NARRATION:ENGLISH`] });
    const outcomes = await processJobs(
      [
        job({ uploadUrl: "http://r2/audio-en.mp3" }),
        job({ language: "PORTUGUESE", uploadUrl: "http://r2/audio-pt.mp3" }),
      ],
      deps,
    );
    expect(outcomes.map((o) => o.status)).toEqual(["READY", "READY"]);
    expect(writes.at(-1)?.value.status).toBe("READY");
  });

  it("still completes READY when the initial QUEUED write fails and logs redis.writeFailed", async () => {
    const { deps, writes, records } = makeDeps({ redisFailKeys: [`${POST_ID}:NARRATION:ENGLISH`] });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (line: string) => {
      warnings.push(line);
    };

    try {
      const outcomes = await processJobs([job({})], deps);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.status).toBe("READY");

      const writeFailed = warnings
        .map((line) => JSON.parse(line) as { event?: string })
        .filter((entry) => entry.event === "redis.writeFailed");
      expect(writeFailed.length).toBeGreaterThan(0);
      expect(writeFailed[0].status).toBe("QUEUED");
      expect(JSON.stringify(writeFailed)).toContain("unavailable");
    } finally {
      console.warn = originalWarn;
    }

    const statuses = writes.map((w) => w.value.status);
    expect(statuses[0]).toBe("QUEUED");
    expect(statuses.at(-1)).toBe("READY");
    expect(records.some((r) => r.url.endsWith("/v1/audio/speech"))).toBe(true);
  });

  it("logs exactly one artifact.failed even when the Redis FAILED write also fails", async () => {
    const { deps, records } = makeDeps({ failUrls: ["http://r2/bad.mp3"] });
    deps.progressStore = {
      async write() {
        throw new Error("Redis connection lost");
      },
    };
    const failures: string[] = [];
    const originalError = console.error;
    console.error = (line: string) => {
      failures.push(line);
    };

    try {
      const outcomes = await processJobs([job({ uploadUrl: "http://r2/bad.mp3" })], deps);
      expect(outcomes[0]?.status).toBe("FAILED");
    } finally {
      console.error = originalError;
    }

    const artifactFailed = failures
      .map((line) => {
        try {
          return JSON.parse(line) as { event?: string; error?: string; redis?: string };
        } catch {
          return null;
        }
      })
      .filter((entry) => entry?.event === "artifact.failed");
    expect(artifactFailed).toHaveLength(1);
    expect(artifactFailed[0]?.error).toContain("Upload to presigned URL failed");
    expect(artifactFailed[0]?.redis).toContain("unavailable");
    expect(records.filter((r) => r.url.endsWith("/v1/audio/speech")).length > 0).toBe(true);
  });

  it("completes the full pipeline and reports READY without Redis", async () => {
    const { deps, records } = makeDeps({ withoutRedis: true });
    const outcomes = await processJobs([job({}), job({ language: "PORTUGUESE", uploadUrl: "http://r2/n-pt.mp3" })], deps);

    expect(records.filter((r) => r.url.endsWith("/v1/audio/speech"))).toHaveLength(2);
    expect(records.filter((r) => r.method === "PUT")).toHaveLength(2);
    expect(outcomes.map((o) => o.status)).toEqual(["READY", "READY"]);
  });

  it("reports FAILED with the error in outcomes when the upload upstream fails without Redis", async () => {
    const { deps, records } = makeDeps({ withoutRedis: true, failUrls: ["http://r2/bad.mp3"] });
    const outcomes = await processJobs([job({ uploadUrl: "http://r2/bad.mp3" })], deps);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe("FAILED");
    expect(outcomes[0]?.error).toContain("Upload to presigned URL failed");
    expect(records.some((r) => r.url.endsWith("/v1/audio/speech"))).toBe(true);
  });

  it("returns outcomes mixing READY and FAILED for a partial-failure dispatch", async () => {
    const { deps } = makeDeps({ failUrls: ["http://r2/bad-en.mp3"] });
    const outcomes = await processJobs(
      [
        job({ uploadUrl: "http://r2/bad-en.mp3", language: "ENGLISH" }),
        job({ uploadUrl: "http://r2/good-pt.mp3", language: "PORTUGUESE" }),
      ],
      deps,
    );

    const byArtifact = new Map(outcomes.map((o) => [o.artifact, o]));
    expect(byArtifact.get("NARRATION:ENGLISH")?.status).toBe("FAILED");
    expect(byArtifact.get("NARRATION:ENGLISH")?.error).toContain("Upload to presigned URL failed");
    expect(byArtifact.get("NARRATION:PORTUGUESE")?.status).toBe("READY");
  });

  it("keeps the pipeline running when a Redis write fails mid-job and never writes FAILED for it", async () => {
    const { deps, writes } = makeDeps({ redisFailKeys: [`${POST_ID}:NARRATION:ENGLISH`] });
    const outcomes = await processJobs([job({})], deps);

    const statuses = writes.map((w) => w.value.status);
    expect(statuses.at(-1)).toBe("READY");
    expect(outcomes[0]?.status).toBe("READY");
    expect(outcomes[0]?.error).toBeUndefined();
    expect(writes.some((w) => w.value.status === "FAILED")).toBe(false);
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

  function captureWarnings(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const originalWarn = console.warn;
    console.warn = (line: string) => {
      lines.push(line);
    };
    return { lines, restore: () => (console.warn = originalWarn) };
  }

  function warnEvents(lines: string[]): { event?: string; attempt?: number; artifact?: string; reason?: string }[] {
    return lines
      .map((line) => {
        try {
          return JSON.parse(line) as { event?: string; attempt?: number; artifact?: string; reason?: string };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { event?: string; attempt?: number; artifact?: string; reason?: string } =>
        entry?.event === "synthesis.retry",
      );
  }

  it("retries synthesis once on a network-level speech failure and completes READY", async () => {
    const { deps, writes, records } = makeDeps({
      speechResponses: [
        new Error("fetch failed\n    at ...  (UND_ERR_HEADERS_TIMEOUT)"),
        new Response(new Uint8Array(Buffer.from("mp3-audio-bytes")), { status: 200 }),
      ],
    });
    const capture = captureWarnings();
    let outcomes: JobOutcome[];
    try {
      outcomes = await processJobs([job({ uploadUrl: "http://r2/audio.mp3" })], deps);
    } finally {
      capture.restore();
    }
    const retries = warnEvents(capture.lines);
    expect(retries).toHaveLength(1);
    expect(retries[0]?.attempt).toBe(2);
    expect(retries[0]?.artifact).toBe("NARRATION:ENGLISH");
    expect(retries[0]?.reason).toContain("UND_ERR_HEADERS_TIMEOUT");
    expect(records.filter((r) => r.url.endsWith("/v1/audio/speech"))).toHaveLength(2);
    const uploads = records.filter((r) => r.url === "http://r2/audio.mp3" && r.method === "PUT");
    expect(uploads).toHaveLength(1);
    expect(outcomes.map((o) => o.status)).toEqual(["READY"]);
    expect(writes.at(-1)?.value.status).toBe("READY");
  });

  it("does not retry synthesis on a 4xx speech failure", async () => {
    const env = makeDeps({
      speechResponses: [new Response("bad request", { status: 400 })],
    });
    const outcomes = await processJobs([job({ uploadUrl: "http://r2/audio.mp3" })], env.deps);
    expect(env.speechCalls).toBe(1);
    expect(outcomes.map((o) => o.status)).toEqual(["FAILED"]);
    expect(outcomes[0]?.error).toContain("400");
  });

  it("retries synthesis once on a 5xx speech failure and succeeds on the 2nd attempt", async () => {
    const env = makeDeps({
      speechResponses: [
        new Response("upstream exploded", { status: 503 }),
        new Response(new Uint8Array(Buffer.from("mp3-audio-bytes")), { status: 200 }),
      ],
    });
    const outcomes = await processJobs([job({ uploadUrl: "http://r2/audio.mp3" })], env.deps);
    expect(env.speechCalls).toBe(2);
    expect(outcomes.map((o) => o.status)).toEqual(["READY"]);
  });

  it("retries synthesis once on a 429 rate-limit failure and succeeds on the 2nd attempt", async () => {
    const env = makeDeps({
      speechResponses: [
        new Response("too many requests", { status: 429 }),
        new Response(new Uint8Array(Buffer.from("mp3-audio-bytes")), { status: 200 }),
      ],
    });
    const outcomes = await processJobs([job({ uploadUrl: "http://r2/audio.mp3" })], env.deps);
    expect(env.speechCalls).toBe(2);
    expect(outcomes.map((o) => o.status)).toEqual(["READY"]);
  });

  it("fails the artifact after a retried synthesis fails again", async () => {
    const env = makeDeps({
      speechResponses: [new Response("upstream exploded", { status: 502 }), new Response("still down", { status: 502 })],
    });
    const outcomes = await processJobs([job({ uploadUrl: "http://r2/audio.mp3" })], env.deps);
    expect(env.speechCalls).toBe(2);
    expect(outcomes.map((o) => o.status)).toEqual(["FAILED"]);
    const uploads = env.records.filter((r) => r.url === "http://r2/audio.mp3" && r.method === "PUT");
    expect(uploads).toHaveLength(0);
  });

  it("treats a synthesis timeout like a network failure and retries once", async () => {
    const timeout = Object.assign(new Error("This operation was aborted"), { name: "TimeoutError" });
    const env = makeDeps({
      speechResponses: [
        timeout,
        new Response(new Uint8Array(Buffer.from("mp3-audio-bytes")), { status: 200 }),
      ],
    });
    const outcomes = await processJobs([job({ uploadUrl: "http://r2/audio.mp3" })], env.deps);
    expect(env.speechCalls).toBe(2);
    expect(outcomes.map((o) => o.status)).toEqual(["READY"]);
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
} {
  return JSON.parse(body);
}
