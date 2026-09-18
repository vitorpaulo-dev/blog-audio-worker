import http from "node:http";
import { parseAudioJobRequest } from "./validate.js";
import { collectJobs, processJobs, type JobDeps } from "./jobs.js";
import type { Config } from "./config.js";
import type { ProgressStore } from "./progress.js";

export interface ServerDeps {
  config: Config;
  progressStore: ProgressStore;
  openCode: { prompt(text: string): Promise<string> };
}

export function createServer(deps: ServerDeps): http.Server {
  return http.createServer((req, res) => {
    void handle(req, res, deps);
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  if (req.method !== "POST" || pathname(req) !== "/generate") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  const body = await readBody(req);
  if (body === null) {
    res.writeHead(413, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Request body too large" }));
    return;
  }

  let parsed;
  try {
    parsed = parseAudioJobRequest(JSON.parse(body.toString("utf8")));
  } catch (error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Invalid payload" }));
    return;
  }

  const jobs = collectJobs(parsed);
  const jobDeps: JobDeps = {
    config: deps.config,
    progressStore: deps.progressStore,
    openCode: deps.openCode,
    fetchImpl: fetch,
  };

  res.writeHead(202, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ accepted: jobs.map(key) }));

  void processJobs(jobs, jobDeps);
}

function key(job: { type: string; language: string }): string {
  return `${job.type}:${job.language}`;
}

function pathname(req: http.IncomingMessage): string {
  return (req.url ?? "").split("?")[0] ?? "";
}

async function readBody(req: http.IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) {
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
