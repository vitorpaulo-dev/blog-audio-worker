import { describe, expect, it } from "vitest";
import { loadConfig, MissingConfigError } from "../src/config.js";

describe("loadConfig", () => {
  it("rejects a missing REDIS_URL", () => {
    expect(() => loadConfig({ VOICE_STUDIO_URL: "http://studio:3900" })).toThrow(MissingConfigError);
    expect(() => loadConfig({ VOICE_STUDIO_URL: "http://studio:3900" })).toThrow(/REDIS_URL/);
  });

  it("rejects a missing VOICE_STUDIO_URL", () => {
    expect(() => loadConfig({ REDIS_URL: "redis://redis-host:6379" })).toThrow(/VOICE_STUDIO_URL/);
  });

  it("forces network redis targets away from implicit localhost defaults", () => {
    const config = loadConfig({
      REDIS_URL: "redis://user:pass@redis-host:6380/3",
      VOICE_STUDIO_URL: "http://studio:3900/",
    });
    expect(config.redisUrl).toBe("redis://user:pass@redis-host:6380/3");
  });

  it("defaults the port to 3901 and honors overrides", () => {
    expect(loadConfig(base()).port).toBe(3901);
    expect(loadConfig({ ...base(), PORT: "4100" }).port).toBe(4100);
  });

  it("maps OPENCODE_TOKEN with CASE_OPENCODE_TOKEN fallback", () => {
    expect(loadConfig(base()).opencodeToken).toBeUndefined();
    expect(loadConfig({ ...base(), OPENCODE_TOKEN: "tok" }).opencodeToken).toBe("tok");
    expect(loadConfig({ ...base(), CASE_OPENCODE_TOKEN: "case-tok" }).opencodeToken).toBe("case-tok");
  });

  it("prefers per-language voice profiles over the default profile id", () => {
    const config = loadConfig({ ...base(), VOICE_PROFILE_ID: "shared", VOICE_PROFILE_ID_PORTUGUESE: "pt-only" });
    expect(config.profileId).toEqual({ ENGLISH: "shared", PORTUGUESE: "pt-only" });
  });
});

function base(): Record<string, string> {
  return {
    REDIS_URL: "redis://redis-host:6379",
    VOICE_STUDIO_URL: "http://studio:3900",
    OPENCODE_URL: "http://opencode:4096",
  };
}
