import net from "node:net";
import tls from "node:tls";

export interface RedisClient {
  setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void>;
  close(): Promise<void>;
}

interface Pending {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

export interface RedisTarget {
  host: string;
  port: number;
  username: string;
  password: string;
  tls: boolean;
  database: string;
}
export function parseRedisUrl(url: string): RedisTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`REDIS_URL is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new Error("REDIS_URL must use the redis:// or rediss:// scheme");
  }
  const port = Number.parseInt(parsed.port || "6379", 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`REDIS_URL has an invalid port: ${parsed.port}`);
  }
  return {
    host: parsed.hostname,
    port,
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    tls: parsed.protocol === "rediss:",
    database: parsed.pathname.replace(/^\//, ""),
  };
}

export function createRedisClient(url: string): Promise<RedisClient> {
  const target = parseRedisUrl(url);
  const socket = target.tls
    ? tls.connect({ host: target.host, port: target.port, rejectUnauthorized: false })
    : net.createConnection({ host: target.host, port: target.port });
  const pending: Pending[] = [];
  let buffer = Buffer.alloc(0);

  const ready = new Promise<void>((resolve, reject) => {
    socket.once("ready", resolve);
    socket.once("error", (error: Error) => {
      if (pending.length === 0 && !isConnected(socket)) {
        reject(new Error(`Cannot connect to Redis at ${target.host}:${target.port}: ${error.message}`));
        return;
      }
      reject(error);
    });
  });

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (pending.length > 0) {
      const pointer = { offset: 0 };
      let value: string | null;
      try {
        value = parseReply(buffer, pointer);
      } catch (error) {
        buffer = Buffer.alloc(0);
        while (pending.length > 0) {
          pending.shift()?.reject(error as Error);
        }
        socket.emit("error", error);
        return;
      }
      if (value === null) {
        break;
      }
      buffer = Buffer.from(buffer.subarray(pointer.offset));
      const next = pending.shift();
      next?.resolve(value);
    }
  });

  function send(command: string[]): Promise<string> {
    return ready.then(
      () =>
        new Promise<string>((resolve, reject) => {
          const encoded = encodeCommand(command);
          pending.push({ resolve, reject });
          socket.write(encoded, (error) => {
            if (error) {
              const index = pending.findIndex((item) => item.resolve === resolve);
              if (index >= 0) {
                pending.splice(index, 1);
              }
              reject(error);
            }
          });
        }),
    );
  }

  socket.on("error", (error) => {
    while (pending.length > 0) {
      pending.shift()?.reject(error);
    }
  });

  return ready.then(async () => {
    if (target.password) {
      const args = target.username && target.username !== "default"
        ? ["AUTH", target.username, target.password]
        : ["AUTH", target.password];
      const reply = await send(args);
      if (reply !== "OK") {
        throw new Error(`Redis AUTH failed: ${reply}`);
      }
    }
    if (target.database) {
      const reply = await send(["SELECT", target.database]);
      if (reply !== "OK") {
        throw new Error(`Redis SELECT ${target.database} failed: ${reply}`);
      }
    }
    return {
      async setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> {
        const reply = await send(["SET", key, value, "EX", String(ttlSeconds)]);
        if (reply !== "OK") {
          throw new Error(`Unexpected Redis SET reply: ${reply}`);
        }
      },
      async close(): Promise<void> {
        socket.end();
        await new Promise<void>((resolve) => socket.once("close", () => resolve()));
      },
    };
  });
}

export interface RedisClientFactory {
  connect(): Promise<RedisClient>;
}

export class RedisUnavailableError extends Error {}

export function createRedisFactory(url: string): RedisClientFactory {
  return { connect: () => createRedisClient(url) };
}

const RETRY_DELAY_MS = 250;

export function createReconnectingRedisClient(factory: RedisClientFactory): RedisClient {
  let current: RedisClient | null = null;

  async function acquire(expired: boolean): Promise<RedisClient> {
    if (!expired && current) {
      return current;
    }
    disconnect();
    current = await factory.connect();
    return current;
  }

  function disconnect(): void {
    const stale = current;
    current = null;
    void stale?.close().catch(() => undefined);
  }

  return {
    async setWithTtl(key, value, ttlSeconds) {
      let expired = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        let client: RedisClient;
        try {
          client = await acquire(expired);
        } catch (error) {
          expired = true;
          if (attempt === 1) {
            throw new RedisUnavailableError(`Redis unavailable: ${describe(error)}`);
          }
          await delay(RETRY_DELAY_MS);
          continue;
        }
        try {
          await client.setWithTtl(key, value, ttlSeconds);
          return;
        } catch (error) {
          expired = true;
          if (attempt === 1) {
            throw new RedisUnavailableError(`Redis unavailable: ${describe(error)}`);
          }
          await delay(RETRY_DELAY_MS);
        }
      }
    },
    close: async () => {
      disconnect();
    },
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isConnected(socket: net.Socket): boolean {
  try {
    return socket.readyState === "open";
  } catch {
    return false;
  }
}

function encodeCommand(command: string[]): Buffer {
  const parts = command.map((token) => {
    const bytes = Buffer.from(token, "utf8");
    return Buffer.concat([Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from("\r\n")]);
  });
  return Buffer.concat([Buffer.from(`*${command.length}\r\n`), ...parts]);
}

function parseReply(buffer: Buffer, pointer: { offset: number }): string | null {
  if (pointer.offset >= buffer.length) {
    return null;
  }
  const type = String.fromCharCode(buffer[pointer.offset] ?? 0);
  const lineEnd = buffer.indexOf("\r\n", pointer.offset);
  if (lineEnd < 0) {
    return null;
  }
  const line = buffer.subarray(pointer.offset + 1, lineEnd).toString("utf8");
  pointer.offset = lineEnd + 2;

  if (type === "+") return line;
  if (type === "-") throw new Error(`Redis error: ${line}`);
  if (type === ":") return line;

  if (type === "$") {
    const length = Number.parseInt(line, 10);
    if (length < 0) return line;
    const end = pointer.offset + length;
    if (end + 2 > buffer.length) {
      return null;
    }
    const value = buffer.subarray(pointer.offset, end).toString("utf8");
    pointer.offset = end + 2;
    return value;
  }

  throw new Error(`Unsupported Redis reply type: ${type}`);
}
