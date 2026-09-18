import { loadConfig, type Config } from "./config.js";
import { createOpenCodeClient, type OpenCodeClient } from "./opencode.js";
import { createProgressStore } from "./progress.js";
import { createRedisClient, createRedisFactory, createReconnectingRedisClient, type RedisClient } from "./redis.js";
import { createServer } from "./server.js";

export async function startup(provided?: {
  config?: Config;
  redis?: RedisClient;
  openCode?: OpenCodeClient;
  fetchImpl?: typeof fetch;
}): Promise<{ config: Config; redis: RedisClient; server: import("node:http").Server }> {
  const config = provided?.config ?? loadConfig();
  const fetchImpl = provided?.fetchImpl ?? fetch;

  const redis = provided?.redis ?? createReconnectingRedisClient(createRedisFactory(config.redisUrl));
  const progressStore = createProgressStore(redis, config.redisTtlSeconds);

  const openCode =
    provided?.openCode ??
    createOpenCodeClient(config.opencodeUrl, { model: config.opencodeModel, token: config.opencodeToken });

  if (!provided?.redis) {
    probeRedis(config);
  }
  if (!provided?.openCode) {
    probeOpenCode(config, fetchImpl);
  }
  if (!provided?.fetchImpl) {
    probeVoiceStudio(config, fetchImpl);
  }

  const server = createServer({ config, progressStore, openCode });
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  console.log(`blog-audio-worker listening on :${config.port}`);
  return { config, redis, server };
}

function probeRedis(config: Config): void {
  createRedisClient(config.redisUrl)
    .then((client) => {
      console.log(`Redis connected at ${describeRedisTarget(config.redisUrl)}`);
      void client.close();
    })
    .catch((error: unknown) => {
      console.error(`Warning: Redis unavailable at startup (${describe(error)}); artifacts will fail per-job until it reconnects.`);
    });
}

function probeOpenCode(config: Config, fetchImpl: typeof fetch): void {
  fetchImpl(`${config.opencodeUrl.replace(/\/$/, "")}/config`)
    .then((response) => {
      if (!response.ok) {
        console.error(`Warning: OPENCODE_URL (${config.opencodeUrl}) answered ${response.status}.`);
      }
    })
    .catch((error: unknown) => {
      console.error(`Warning: OPENCODE_URL (${config.opencodeUrl}) unreachable at startup: ${describe(error)}.`);
    });
}

function probeVoiceStudio(config: Config, fetchImpl: typeof fetch): void {
  const headers: Record<string, string> = {};
  if (config.voiceStudioToken) {
    headers.Authorization = `Bearer ${config.voiceStudioToken}`;
  }
  fetchImpl(`${config.voiceStudioUrl}/health`, { headers })
    .then(async (response) => {
      const body = (await response.json().catch(() => ({}))) as { status?: string };
      if (!response.ok || body.status !== "ok") {
        console.error(
          `Warning: VOICE_STUDIO_URL (${config.voiceStudioUrl}) health check failed: HTTP ${response.status} ${JSON.stringify(body)}.`,
        );
      }
    })
    .catch((error: unknown) => {
      console.error(`Warning: VOICE_STUDIO_URL (${config.voiceStudioUrl}) unreachable at startup: ${describe(error)}.`);
    });
}

function describeRedisTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || "6379"}`;
  } catch {
    return "<invalid>";
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1]?.endsWith("index.js")) {
  const running = await startup().catch((error: unknown) => {
    console.error(message(error));
    process.exit(1);
  });
  if (running) {
    const { redis, server } = running;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        server.close(() => {
          redis.close().finally(() => process.exit(0));
        });
      });
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
