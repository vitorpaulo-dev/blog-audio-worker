export interface Config {
  port: number;
  opencodeUrl: string;
  voiceStudioUrl: string;
  voiceStudioToken: string;
  redisUrl: string;
  profileId: Record<string, string>;
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

function profileFor(env: NodeJS.ProcessEnv, language: string): string {
  const perLanguage = env[`VOICE_PROFILE_ID_${language}`];
  return perLanguage || env.VOICE_PROFILE_ID || "default";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: parsePort(env.PORT),
    opencodeUrl: env.OPENCODE_URL?.trim() || "http://localhost:4096",
    voiceStudioUrl: required(env.VOICE_STUDIO_URL, "VOICE_STUDIO_URL").replace(/\/$/, ""),
    voiceStudioToken: env.VOICE_STUDIO_TOKEN?.trim() ?? "",
    redisUrl: required(env.REDIS_URL, "REDIS_URL"),
    profileId: {
      ENGLISH: profileFor(env, "ENGLISH"),
      PORTUGUESE: profileFor(env, "PORTUGUESE"),
    },
    opencodeModel: env.OPENCODE_MODEL?.trim() || undefined,
    opencodeToken: env.OPENCODE_TOKEN?.trim() || env.CASE_OPENCODE_TOKEN?.trim() || undefined,
    concurrencyLimit: 2,
    redisTtlSeconds: 7 * 24 * 60 * 60,
  };
}
