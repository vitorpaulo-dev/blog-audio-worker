import { describe, expect, it } from "vitest";
import { createReconnectingRedisClient, RedisUnavailableError, type RedisClient } from "../src/redis.js";
import type { RedisClientFactory } from "../src/redis.js";

function okClient(calls: string[][]): RedisClient {
  return {
    async setWithTtl(key, value, ttl) {
      calls.push(["SET", key, value, ttl]);
    },
    close: async () => undefined,
  };
}

function factorySequence(clients: (RedisClient | Error)[]): RedisClientFactory {
  let index = 0;
  return {
    connect: async () => {
      const next = clients[index++];
      if (next instanceof Error) {
        throw next;
      }
      if (!next) {
        throw new Error("factory exhausted");
      }
      return next;
    },
  };
}

describe("createReconnectingRedisClient", () => {
  it("writes through a successful connection", async () => {
    const calls: string[][] = [];
    const client = createReconnectingRedisClient(factorySequence([okClient(calls)]));
    await client.setWithTtl("k", "v", 60);
    expect(calls).toEqual([["SET", "k", "v", 60]]);
  });

  it("reconnects and retries once when the first connection fails", async () => {
    const calls: string[][] = [];
    const client = createReconnectingRedisClient(
      factorySequence([new Error("connection refused"), okClient(calls)]),
    );
    await client.setWithTtl("k", "v", 60);
    expect(calls).toEqual([["SET", "k", "v", 60]]);
  });

  it("reconnects and retries once when the live connection breaks mid-write", async () => {
    const calls: string[][] = [];
    const flaky = okClient(calls);
    flaky.setWithTtl = async () => {
      throw new Error("socket hang up");
    };
    const client = createReconnectingRedisClient(factorySequence([flaky, okClient(calls)]));
    await client.setWithTtl("k", "v", 60);
    expect(calls).toEqual([["SET", "k", "v", 60]]);

    const again: string[][] = [];
    const persistent = okClient(again);
    await client.setWithTtl("k2", "v2", 60).catch(() => undefined);
    persistent.setWithTtl("k3", "v3", 60);
  });

  it("fails with RedisUnavailableError after two failed attempts", async () => {
    const client = createReconnectingRedisClient(
      factorySequence([new Error("e1"), new Error("e2")]),
    );
    await expect(client.setWithTtl("k", "v", 60)).rejects.toBeInstanceOf(RedisUnavailableError);
  });

  it("reuses the live connection across writes", async () => {
    let connections = 0;
    const client = createReconnectingRedisClient({
      connect: async () => {
        connections++;
        return okClient([]);
      },
    });
    await client.setWithTtl("a", "1", 60);
    await client.setWithTtl("b", "2", 60);
    expect(connections).toBe(1);
  });
});
