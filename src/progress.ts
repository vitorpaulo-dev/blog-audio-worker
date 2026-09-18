import type { AudioProgress, AudioStatus } from "./types.js";

export interface ProgressStore {
  write(postId: string, type: string, language: string, progress: AudioProgress): Promise<void>;
}

class RedisProgressStore {
  constructor(
    private readonly redis: { setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> },
    private readonly ttlSeconds: number,
  ) {}

  async write(postId: string, type: string, language: string, progress: AudioProgress): Promise<void> {
    const key = `${postId}:${type}:${language}`;
    const value = serialize(progress);
    try {
      await this.redis.setWithTtl(key, value, this.ttlSeconds);
    } catch (error) {
      throw new RedisWriteError(key, error as Error);
    }
  }
}

export function createProgressStore(
  redis: { setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> },
  ttlSeconds: number,
): ProgressStore {
  return new RedisProgressStore(redis, ttlSeconds);
}

export class RedisWriteError extends Error {
  constructor(
    readonly key: string,
    cause: Error,
  ) {
    super(`Failed to write progress to Redis for ${key}: ${cause.message}`);
  }
}

function serialize(progress: AudioProgress): string {
  return JSON.stringify({
    status: progress.status,
    progress: progress.progress,
    ...(progress.error !== undefined ? { error: progress.error } : {}),
  });
}
