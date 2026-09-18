import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ServerDeps } from "../src/server.js";
import type { AudioProgress } from "../src/types.js";

const POST_ID = "d0a3f5c9-1f2b-4a1e-9b8c-7d5e3a2f1b0a";

function startServer(): Promise<{
  port: number;
  writes: { key: string; value: AudioProgress }[];
  putRequests: { url: string; body: string }[];
  putPort: number;
  close: () => Promise<void>;
}> {
  const writes: { key: string; value: AudioProgress }[] = [];
  const putRequests: { url: string; body: string }[] = [];

  function listen(target: http.Server): Promise<number> {
    return new Promise((resolve) => {
      const t = target.listen(0, "127.0.0.1", () => {
        resolve((target.address() as { port: number }).port);
      });
      void t;
    });
  }

  const upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end("wav-audio-bytes");
      putRequests.push({ url: "internal", body });
    });
  });

  const putServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      putRequests.push({ url: String(req.url ?? ""), body });
      res.writeHead(200);
      res.end();
    });
  });

  const deps: ServerDeps = {
    config: {
      port: 0,
      opencodeUrl: "",
      voiceStudioUrl: "",
      voiceStudioToken: "",
      redisUrl: "redis://localhost:6379",
      profileId: {},
      concurrencyLimit: 2,
      redisTtlSeconds: 100,
    },
    progressStore: {
      async write(postId, type, language, progress) {
        writes.push({ key: `${postId}:${type}:${language}`, value: progress });
      },
    },
    openCode: { prompt: async () => `[{"speaker":"HOST","text":"Hi"}]` },
  };

  const server = createServer(deps);

  return (async () => {
    const upstreamPort = await listen(upstream);
    const putPort = await listen(putServer);
    const port = await listen(server);

    deps.config.opencodeUrl = `http://127.0.0.1:${upstreamPort}`;
    deps.config.voiceStudioUrl = `http://127.0.0.1:${upstreamPort}`;

    async function close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await new Promise<void>((resolve) => putServer.close(() => resolve()));
    }

    return {
      port,
      writes,
      putRequests,
      putPort,
      close,
    };
  })();
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function post(port: number, path: string, payload: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function payload(uploads: unknown): Record<string, unknown> {
  return {
    postId: POST_ID,
    postSlug: "my-post",
    contents: [
      { language: "ENGLISH", title: "T", content: "C" },
      { language: "PORTUGUESE", title: "P", content: "Q" },
    ],
    uploads,
  };
}

const fullUploads = (putPort: number) => ({
  NARRATION: { ENGLISH: `http://127.0.0.1:${putPort}/n-en`, PORTUGUESE: `http://127.0.0.1:${putPort}/n-pt` },
  PODCAST: { ENGLISH: `http://127.0.0.1:${putPort}/p-en`, PORTUGUESE: `http://127.0.0.1:${putPort}/p-pt` },
});

interface ServerHandle {
  port: number;
  writes: { key: string; value: AudioProgress }[];
  putRequests: { url: string; body: string }[];
  putPort: number;
  close: () => Promise<void>;
}

describe("server POST /generate", () => {
  let server: ServerHandle;

  beforeAll(async () => {
    server = (await startServer()) as ServerHandle;
  });

  afterAll(() => server.close());

  it("returns 202 immediately with the accepted artifact keys", async () => {
    const response = await post(server.port, "/generate", payload(fullUploads(server.putPort)));
    expect(response.status).toBe(202);
    const json = (await response.json()) as { accepted: string[] };
    expect(json.accepted.sort()).toEqual([
      "NARRATION:ENGLISH",
      "NARRATION:PORTUGUESE",
      "PODCAST:ENGLISH",
      "PODCAST:PORTUGUESE",
    ]);
  });

  it("processes every accepted job in the background", async () => {
    await waitFor(() => server.writes.filter((w) => w.value.status === "READY").length >= 4);
    expect(server.writes.every((w) => w.value.status !== "FAILED")).toBe(true);
  });

  it("rejects an invalid payload with 400", async () => {
    const response = await post(server.port, "/generate", { postId: "x" });
    expect(response.status).toBe(400);
  });

  it("rejects a malformed body with 400", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });

  it("rejects unknown routes with 404", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/other`);
    expect(response.status).toBe(404);
  });
});
