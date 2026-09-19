import { loadConfig, type Config } from "./config.js";
import { createOpenCodeClient, type OpenCodeClient } from "./opencode.js";
import { createNoopProgressStore, createProgressStore, type ProgressStore } from "./progress.js";
import { createRedisClient, createRedisFactory, createReconnectingRedisClient, type RedisClient } from "./redis.js";
import { createServer } from "./server.js";
import { logEvent } from "./logger.js";

export async function startup(provided?: {
  config?: Config;
  redis?: RedisClient;
  openCode?: OpenCodeClient;
  fetchImpl?: typeof fetch;
}): Promise<{ config: Config; redis: RedisClient | null; server: import("node:http").Server }> {
  const config = provided?.config ?? loadConfig();
  const fetchImpl = provided?.fetchImpl ?? fetch;

  const { redis, progressStore } = redisSetup(config, provided?.redis);

  const openCode =
    provided?.openCode ??
    createOpenCodeClient(config.opencodeUrl, { model: config.opencodeModel, token: config.opencodeToken });

  if (!provided?.fetchImpl) {
    probeVoiceStudio(config, fetchImpl);
  }
  if (!provided?.openCode) {
    probeOpenCode(config, fetchImpl);
  }

  const server = createServer({ config, progressStore, openCode });
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  logEvent("worker.listening", { port: config.port, redis: redis ? "enabled" : "disabled" });
  return { config, redis, server };
}

function redisSetup(
  config: Config,
  providedRedis: RedisClient | undefined,
): { redis: RedisClient | null; progressStore: ProgressStore } {
  if (providedRedis) {
    return { redis: providedRedis, progressStore: createProgressStore(providedRedis, config.redisTtlSeconds) };
  }
  if (!config.redisUrl) {
    logEvent("redis.disabled", {
      message: "REDIS_URL is unset; progress writes are skipped and consumers fall back to the database status.",
    });
    return { redis: null, progressStore: createNoopProgressStore() };
  }
  const redis = createReconnectingRedisClient(createRedisFactory(config.redisUrl));
  probeRedis(config);
  return { redis, progressStore: createProgressStore(redis, config.redisTtlSeconds) };
}

function probeRedis(config: Config): void {
  createRedisClient(config.redisUrl as string)
    .then((client) => {
      logEvent("redis.connected", { target: describeRedisTarget(config.redisUrl as string) });
      void client.close();
    })
    .catch((error: unknown) => {
      logEvent(
        "redis.probeFailed",
        {
          target: describeRedisTarget(config.redisUrl as string),
          message: `${describe(error)}; artifacts will fail per-job until it reconnects.`,
        },
        "error",
      );
    });
}

function probeOpenCode(config: Config, fetchImpl: typeof fetch): void {
  fetchImpl(`${config.opencodeUrl.replace(/\/$/, "")}/config`)
    .then((response) => {
      if (!response.ok) {
        logEvent("opencode.probeFailed", { url: config.opencodeUrl, status: response.status }, "error");
      }
    })
    .catch((error: unknown) => {
      logEvent("opencode.probeFailed", { url: config.opencodeUrl, message: describe(error) }, "error");
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
        logEvent("voicestudio.probeFailed", { url: config.voiceStudioUrl, status: response.status, body: JSON.stringify(body) }, "error");
      }
    })
    .catch((error: unknown) => {
      logEvent("voicestudio.probeFailed", { url: config.voiceStudioUrl, message: describe(error) }, "error");
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

export function shutdown(server: import("node:http").Server, redis: RedisClient | null): void {
  server.close(() => {
    if (!redis) {
      process.exit(0);
      return;
    }
    void redis.close().finally(() => process.exit(0));
  });
}

if (process.argv[1]?.endsWith("index.js")) {
  const running = await startup().catch((error: unknown) => {
    console.error(message(error));
    process.exit(1);
  });
  if (running) {
    const { redis, server } = running;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => shutdown(server, redis));
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
