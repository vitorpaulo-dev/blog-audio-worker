import { describe, expect, it } from "vitest";
import { parseRedisUrl } from "../src/redis.js";
import { loadConfig } from "../src/config.js";

describe("parseRedisUrl", () => {
  it("parses a plain network address", () => {
    const target = parseRedisUrl("redis://10.0.0.5:6379");
    expect(target).toMatchObject({ host: "10.0.0.5", port: 6379, password: "", tls: false });
  });

  it("parses host and default port without explicit port", () => {
    const target = parseRedisUrl("redis://redis.internal");
    expect(target.port).toBe(6379);
  });

  it("parses the password-only auth form", () => {
    const target = parseRedisUrl("redis://:s3cret@redis-host:6379");
    expect(target.password).toBe("s3cret");
    expect(target.host).toBe("redis-host");
  });

  it("parses username and password auth form", () => {
    const target = parseRedisUrl("redis://admin:p%40ss@redis-host:6380");
    expect(target.username).toBe("admin");
    expect(target.password).toBe("p@ss");
    expect(target.port).toBe(6380);
  });

  it("marks rediss:// as TLS", () => {
    expect(parseRedisUrl("rediss://:pw@host:6379").tls).toBe(true);
  });

  it("extracts a database from the path", () => {
    expect(parseRedisUrl("redis://host:6379/3").database).toBe("3");
  });

  it("rejects non-redis schemes", () => {
    expect(() => parseRedisUrl("http://host:6379")).toThrow("redis:// or rediss://");
  });
});

describe("loadConfig required env", () => {
  it("accepts a missing REDIS_URL as redis disabled", () => {
    const config = loadConfig({ VOICE_STUDIO_URL: "http://vs" } as NodeJS.ProcessEnv);
    expect(config.redisUrl).toBeUndefined();
    expect(config.voiceStudioUrl).toBe("http://vs");
  });

  it("throws when VOICE_STUDIO_URL is missing", () => {
    expect(() => loadConfig({ REDIS_URL: "redis://h" } as NodeJS.ProcessEnv)).toThrow("VOICE_STUDIO_URL");
  });

  it("keeps defaults for optional values", () => {
    const config = loadConfig({
      REDIS_URL: "redis://h",
      VOICE_STUDIO_URL: "http://vs/",
    } as NodeJS.ProcessEnv);
    expect(config.opencodeUrl).toBe("http://localhost:4096");
    expect(config.port).toBe(3901);
    expect(config.voiceStudioUrl).toBe("http://vs");
    expect(config.voiceProfiles.PORTUGUESE).toEqual({});
  });
});
