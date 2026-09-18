import { afterEach, describe, expect, it, vi } from "vitest";

interface FakeSocketLike {
  written: Buffer[];
  readyState: string;
  lastEncoded: string;
  on: (event: string, listener: (arg: unknown) => void) => void;
  once: (event: string, listener: (arg: unknown) => void) => void;
  emit: (event: string, arg?: unknown) => void;
  write: (data: Buffer, callback?: (error?: Error) => void) => boolean;
  end: () => void;
}

const harness = vi.hoisted(() => {
  class Emitter {
    private handlers = new Map<string, Array<(arg: unknown) => void>>();

    on(event: string, listener: (arg: unknown) => void): void {
      const list = this.handlers.get(event) ?? [];
      list.push(listener);
      this.handlers.set(event, list);
    }

    once(event: string, listener: (arg: unknown) => void): void {
      const list = this.handlers.get(event) ?? [];
      const wrapped = (arg: unknown) => {
        const current = this.handlers.get(event) ?? [];
        const index = current.indexOf(wrapped);
        if (index >= 0) {
          current.splice(index, 1);
          this.handlers.set(event, current);
        }
        listener(arg);
      };
      list.push(wrapped);
      this.handlers.set(event, list);
    }

    emit(event: string, arg?: unknown): void {
      for (const listener of [...(this.handlers.get(event) ?? [])]) {
        listener(arg);
      }
    }
  }

  class FakeSocket extends Emitter {
    written: Buffer[] = [];
    readyState = "open";

    write(data: Buffer, callback?: (error?: Error) => void): boolean {
      this.written.push(data);
      if (callback) {
        callback();
      }
      return true;
    }

    end(): void {
      this.emit("close");
    }

    get lastEncoded(): string {
      return (this.written.at(-1) ?? Buffer.alloc(0)).toString("utf8");
    }
  }

  const sockets: FakeSocket[] = [];
  return { FakeSocket, sockets };
});

vi.mock("node:net", () => ({
  default: {
    createConnection: (options: unknown) => {
      const socket = new harness.FakeSocket(options as object);
      harness.sockets.push(socket);
      return socket;
    },
  },
}));

const { createRedisClient } = await import("../src/redis.js");

function connect(): {
  socket: FakeSocketLike;
  client: Promise<Awaited<ReturnType<typeof createRedisClient>>>;
} {
  const clientPromise = createRedisClient("redis://redis-host:6379");
  const socket = harness.sockets.at(-1) as FakeSocketLike;
  socket.readyState = "open";
  socket.emit("ready");
  return { socket, client: clientPromise };
}

afterEach(() => {
  harness.sockets.length = 0;
});

describe("createRedisClient RESP write path", () => {
  it("sends SET with EX ttl as RESP array and resolves on +OK", async () => {
    const { socket, client } = connect();
    const resolved = client.then((c) => c.setWithTtl("post-1:NARRATION:ENGLISH", '{"status":"READY","progress":100}', 604800));

    await vi.waitFor(() => {
      expect(socket.lastEncoded).toContain("SET");
    });

    expect(socket.lastEncoded).toBe(
      "*5\r\n$3\r\nSET\r\n$24\r\npost-1:NARRATION:ENGLISH\r\n$33\r\n{\"status\":\"READY\",\"progress\":100}\r\n$2\r\nEX\r\n$6\r\n604800\r\n",
    );

    socket.emit("data", Buffer.from("+OK\r\n"));
    await expect(resolved).resolves.toBeUndefined();
  });

  it("rejects the write when the server replies with a RESP error", async () => {
    const { socket, client } = connect();
    const writePromise = client.then((c) => c.setWithTtl("k", "v", 10));
    await vi.waitFor(() => {
      expect(socket.written.length).toBe(1);
    });
    socket.emit("data", Buffer.from("-ERR quota exceeded\r\n"));
    await expect(writePromise).rejects.toThrow("Redis error: ERR quota exceeded");
  });

  it("handles a reply split across multiple chunks", async () => {
    const { socket, client } = connect();
    const writePromise = client.then((c) => c.setWithTtl("k", "v", 10));
    await vi.waitFor(() => {
      expect(socket.written.length).toBe(1);
    });
    socket.emit("data", Buffer.from("+O"));
    socket.emit("data", Buffer.from("K\r\n"));
    await expect(writePromise).resolves.toBeUndefined();
  });
});
