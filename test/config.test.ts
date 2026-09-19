import { describe, expect, it } from "vitest";
import { loadConfig, resolveVoiceProfile, VoiceProfileMissingError } from "../src/config.js";

describe("loadConfig", () => {
  it("accepts a missing REDIS_URL and leaves redis unset", () => {
    const config = loadConfig({ VOICE_STUDIO_URL: "http://studio:3900" });
    expect(config.redisUrl).toBeUndefined();
    expect(config.voiceStudioUrl).toBe("http://studio:3900");
  });

  it("accepts an empty REDIS_URL as redis disabled", () => {
    expect(loadConfig({ ...base(), REDIS_URL: "   " }).redisUrl).toBeUndefined();
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

  it("parses per-language host and guest voice profiles", () => {
    const config = loadConfig({
      ...base(),
      VOICE_PROFILE_ID_ENGLISH_HOST: "host_en",
      VOICE_PROFILE_ID_ENGLISH_GUEST: "guest_en",
      VOICE_PROFILE_ID_PORTUGUESE_HOST: "host_pt",
      VOICE_PROFILE_ID_PORTUGUESE_GUEST: "guest_pt",
    });
    expect(config.voiceProfiles).toEqual({
      ENGLISH: { host: "host_en", guest: "guest_en" },
      PORTUGUESE: { host: "host_pt", guest: "guest_pt" },
    });
  });

  it("omits empty voice profile env values", () => {
    const config = loadConfig(base());
    expect(config.voiceProfiles).toEqual({ ENGLISH: {}, PORTUGUESE: {} });
  });

  it("resolves narration and podcast host segments from the _HOST profile per language", () => {
    const profiles = {
      ENGLISH: { host: "host-en", guest: "guest-en" },
      PORTUGUESE: { host: "host-pt", guest: "guest-pt" },
    };
    expect(resolveVoiceProfile(profiles, "HOST", "ENGLISH")).toBe("host-en");
    expect(resolveVoiceProfile(profiles, "HOST", "PORTUGUESE")).toBe("host-pt");
  });

  it("resolves podcast guest segments from the _GUEST profile per language", () => {
    const profiles = {
      ENGLISH: { host: "host-en", guest: "guest-en" },
      PORTUGUESE: { host: "host-pt" },
    };
    expect(resolveVoiceProfile(profiles, "GUEST", "ENGLISH")).toBe("guest-en");
  });

  it("throws voiceMissing when the HOST profile is unset, even when a GUEST profile exists", () => {
    const profiles = {
      ENGLISH: { guest: "guest-en" },
      PORTUGUESE: {},
    };
    expect(() => resolveVoiceProfile(profiles, "HOST", "ENGLISH")).toThrowError(VoiceProfileMissingError);
    expect(() => resolveVoiceProfile(profiles, "HOST", "ENGLISH")).toThrow("voiceMissing");
    expect(() => resolveVoiceProfile({}, "HOST", "PORTUGUESE")).toThrowError(VoiceProfileMissingError);
  });

  it("throws voiceMissing when the GUEST profile is unset, even when a HOST profile exists", () => {
    const profiles = {
      ENGLISH: { host: "host-en" },
      PORTUGUESE: {},
    };
    expect(() => resolveVoiceProfile(profiles, "GUEST", "ENGLISH")).toThrowError(VoiceProfileMissingError);
    expect(() => resolveVoiceProfile(profiles, "GUEST", "PORTUGUESE")).toThrowError(VoiceProfileMissingError);
  });

  it("throws voiceMissing when both variants are empty for the language", () => {
    expect(() => resolveVoiceProfile({}, "HOST", "ENGLISH")).toThrowError(VoiceProfileMissingError);
    expect(() => resolveVoiceProfile({ ENGLISH: {}, PORTUGUESE: {} }, "GUEST", "PORTUGUESE")).toThrowError(VoiceProfileMissingError);
  });

  it("names the missing env var and language in the error", () => {
    let message = "";
    try {
      resolveVoiceProfile({ PORTUGUESE: {} }, "GUEST", "PORTUGUESE");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("VOICE_PROFILE_ID_PORTUGUESE_GUEST");
    expect(message).not.toContain("ENGLISH");
  });
});

function base(): Record<string, string> {
  return {
    REDIS_URL: "redis://redis-host:6379",
    VOICE_STUDIO_URL: "http://studio:3900",
    OPENCODE_URL: "http://opencode:4096",
  };
}
