import { describe, expect, it } from "vitest";
import { createNoopProgressStore, createProgressStore } from "../src/progress.js";

function fakeRedis() {
  const writes: { key: string; value: string; ttl: number }[] = [];
  return {
    writes,
    setWithTtl(key: string, value: string, ttl: number) {
      writes.push({ key, value, ttl });
      return Promise.resolve();
    },
  };
}

const POST_ID = "d0a3f5c9-1f2b-4a1e-9b8c-7d5e3a2f1b0a";
const TTL = 7 * 24 * 60 * 60;

describe("progress store", () => {
  it("writes JSON payload under {postId}:{type}:{language} with TTL", async () => {
    const redis = fakeRedis();
    const store = createProgressStore(redis, TTL);
    await store.write(POST_ID, "NARRATION", "ENGLISH", { status: "GENERATING", progress: 42 });
    expect(redis.writes).toHaveLength(1);
    expect(redis.writes[0]?.key).toBe(`${POST_ID}:NARRATION:ENGLISH`);
    expect(redis.writes[0]?.ttl).toBe(TTL);
    expect(JSON.parse(redis.writes[0]?.value ?? "")).toEqual({ status: "GENERATING", progress: 42 });
  });

  it("serializes FAILED status with error message", async () => {
    const redis = fakeRedis();
    const store = createProgressStore(redis, TTL);
    await store.write(POST_ID, "PODCAST", "PORTUGUESE", { status: "FAILED", progress: 0, error: "boom" });
    const value = redis.writes[0]?.value ?? "";
    const parsed = JSON.parse(value) as Record<string, unknown>;
    expect(parsed).toEqual({ status: "FAILED", progress: 0, error: "boom" });
    expect(Object.keys(parsed)).toEqual(["status", "progress", "error"]);
  });

  it("does not serialize an absent error", async () => {
    const redis = fakeRedis();
    const store = createProgressStore(redis, TTL);
    await store.write(POST_ID, "PODCAST", "ENGLISH", { status: "READY", progress: 100 });
    expect(JSON.parse(redis.writes[0]?.value ?? "")).toEqual({ status: "READY", progress: 100 });
  });

  it("offers a no-op store that resolves writes without touching Redis", async () => {
    const store = createNoopProgressStore();
    await expect(store.write(POST_ID, "NARRATION", "ENGLISH", { status: "QUEUED", progress: 0 })).resolves.toBeUndefined();
    await expect(store.write(POST_ID, "NARRATION", "ENGLISH", { status: "READY", progress: 100 })).resolves.toBeUndefined();
    await expect(store.write(POST_ID, "NARRATION", "ENGLISH", { status: "FAILED", progress: 0, error: "boom" })).resolves.toBeUndefined();
  });
});
