import { afterEach, describe, expect, it, vi } from "vitest";
import { startup, shutdown } from "../src/index.js";
import type { RedisClient } from "../src/redis.js";
import type { Config } from "../src/config.js";

function baseConfig(partial: Partial<Config> = {}): Config {
  return {
    port: 0,
    opencodeUrl: "",
    voiceStudioUrl: "",
    voiceStudioToken: "",
    redisUrl: undefined,
    voiceProfiles: {},
    concurrencyLimit: 2,
    redisTtlSeconds: 100,
    ...partial,
  };
}

describe("startup", () => {
  it("starts without Redis when REDIS_URL is unset and uses a no-op progress store", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (line: string) => {
      logs.push(line);
    };

    try {
      const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      const { redis, server } = await startup({
        config: baseConfig(),
        openCode: { prompt: async () => "" },
        fetchImpl,
      });

      expect(redis).toBeNull();
      const disabledLog = logs.find((line) => line.includes('"event":"redis.disabled"'));
      expect(disabledLog).toBeDefined();
      expect(JSON.parse(disabledLog as string).event).toBe("redis.disabled");

      await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      console.log = originalLog;
    }
  });

  it("keeps Redis wired when REDIS_URL is configured and probes it, logging a warning when unreachable", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (line: string) => {
      errors.push(line);
    };

    try {
      const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      const { redis, server } = await startup({
        config: baseConfig({ redisUrl: "redis://127.0.0.1:1", voiceStudioToken: "" }),
        openCode: { prompt: async () => "" },
        fetchImpl,
      });

      expect(redis).not.toBeNull();
      await new Promise<void>((resolve) => server.close(() => resolve()));

      await new Promise((resolve) => setTimeout(resolve, 250));
      const probeError = errors.find((line) => line.includes('"event":"redis.probeFailed"'));
      expect(probeError).toBeDefined();
    } finally {
      console.error = originalError;
    }
  });
});

describe("shutdown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits cleanly with SIGINT-style shutdown when Redis is disabled (regression: no TypeError on null.close)", async () => {
    const server = (await startup({
      config: baseConfig(),
      openCode: { prompt: async () => "" },
      fetchImpl: async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    })).server;

    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    expect(() => shutdown(server, null)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exit).toHaveBeenCalledWith(0);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("closes the store before exiting when Redis is enabled", async () => {
    const server = (await startup({
      config: baseConfig(),
      openCode: { prompt: async () => "" },
      fetchImpl: async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    })).server;

    const closed: string[] = [];
    const redis: RedisClient = {
      setWithTtl: async () => undefined,
      close: async () => {
        closed.push("closed");
      },
    };
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    shutdown(server, redis);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toEqual(["closed"]);
    expect(exit).toHaveBeenCalledWith(0);
    exit.mockRestore();
  });
});
