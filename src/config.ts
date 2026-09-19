export interface Config {
  port: number;
  opencodeUrl: string;
  voiceStudioUrl: string;
  voiceStudioToken: string;
  redisUrl?: string;
  voiceProfiles: Record<string, VoiceProfiles>;
  opencodeModel?: string;
  opencodeToken?: string;
  concurrencyLimit: number;
  redisTtlSeconds: number;
}

export class MissingConfigError extends Error {}

function parsePort(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3901;
}

function required(value: string | undefined, name: string): string {
  if (!value || value.trim().length === 0) {
    throw new MissingConfigError(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

export type VoiceLanguage = "ENGLISH" | "PORTUGUESE";

export type VoiceRole = "HOST" | "GUEST";

export interface VoiceProfiles {
  host?: string;
  guest?: string;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function voiceProfilesFor(env: NodeJS.ProcessEnv, language: VoiceLanguage): VoiceProfiles {
  return {
    host: optional(env[`VOICE_PROFILE_ID_${language}_HOST`]),
    guest: optional(env[`VOICE_PROFILE_ID_${language}_GUEST`]),
  };
}

export class VoiceProfileMissingError extends Error {
  constructor(role: VoiceRole, language: string) {
    super(`voiceMissing: VOICE_PROFILE_ID_${language}_${role} is not configured`);
    this.name = "VoiceProfileMissingError";
  }
}

export function resolveVoiceProfile(
  voiceProfiles: Record<string, VoiceProfiles | undefined>,
  role: VoiceRole,
  language: string,
): string {
  const profiles = voiceProfiles[language] ?? {};
  const profile = role === "GUEST" ? profiles.guest : profiles.host;
  if (!profile) {
    throw new VoiceProfileMissingError(role, language);
  }
  return profile;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: parsePort(env.PORT),
    opencodeUrl: env.OPENCODE_URL?.trim() || "http://localhost:4096",
    voiceStudioUrl: required(env.VOICE_STUDIO_URL, "VOICE_STUDIO_URL").replace(/\/$/, ""),
    voiceStudioToken: env.VOICE_STUDIO_TOKEN?.trim() ?? "",
    redisUrl: optional(env.REDIS_URL),
    voiceProfiles: {
      ENGLISH: voiceProfilesFor(env, "ENGLISH"),
      PORTUGUESE: voiceProfilesFor(env, "PORTUGUESE"),
    },
    opencodeModel: env.OPENCODE_MODEL?.trim() || undefined,
    opencodeToken: env.OPENCODE_TOKEN?.trim() || env.CASE_OPENCODE_TOKEN?.trim() || undefined,
    concurrencyLimit: 2,
    redisTtlSeconds: 7 * 24 * 60 * 60,
  };
}
