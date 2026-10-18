import { existsSync } from "node:fs";

import { CliError } from "./errors.ts";

import {
  assertProfileSelectionIsUnambiguous,
  defaultConfigPath,
  defaultTokenCachePath,
  loadFileConfig,
  profileConfigPath,
  profileNameFromEnv,
  resolveUserPath,
  type FileConfig,
} from "./profiles.ts";

export const DEFAULT_BASE_URL = "https://api.vanta.com";
export const DEFAULT_SCOPE = "vanta-api.all:read";
export const DEFAULT_AUDITOR_SCOPE = "auditor-api.audit:read";
export const DEFAULT_TIMEOUT_MS = 30_000;

export {
  DEFAULT_CACHE_DIR,
  DEFAULT_CONFIG_DIR,
  DEFAULT_PROFILES_DIR,
  LEGACY_CONFIG_PATH,
  listProfiles,
  profileConfigPath,
  profileNameFromEnv,
  profilesDir,
  removeProfile,
  saveProfile,
  type FileConfig,
} from "./profiles.ts";

/** @deprecated use profileNameFromEnv — kept for call-site clarity */
export const profileName = profileNameFromEnv;

export type VantaConfig = {
  timeoutMs?: number;
  baseUrl: string;
  clientId?: string;
  clientSecret?: string;
  scope: string;
  tokenCachePath: string;
  profile?: string;
  configPath?: string;
};

export function parseTimeoutMs(value?: string): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 600_000) {
    throw new CliError("--timeout-ms must be an integer from 1 to 600000.");
  }
  return Number(value);
}

export type LoadConfigOptions = {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  /** Explicit profile from CLI `--profile`. Not applied via process.env mutation. */
  profile?: string;
};

type CredentialScope = {
  kind: "manage" | "auditor";
  defaultScope: string;
  envBaseUrl: string;
  envClientId: string;
  envClientSecret: string;
  envScope: string;
  envTokenCache: string;
  fileBaseUrl: keyof FileConfig;
  fileClientId: keyof FileConfig;
  fileClientSecret: keyof FileConfig;
  fileScope: keyof FileConfig;
  fileTokenCache: keyof FileConfig;
};

const MANAGE_SCOPE: CredentialScope = {
  kind: "manage",
  defaultScope: DEFAULT_SCOPE,
  envBaseUrl: "VANTA_BASE_URL",
  envClientId: "VANTA_CLIENT_ID",
  envClientSecret: "VANTA_CLIENT_SECRET",
  envScope: "VANTA_SCOPE",
  envTokenCache: "VANTA_TOKEN_CACHE_PATH",
  fileBaseUrl: "baseUrl",
  fileClientId: "clientId",
  fileClientSecret: "clientSecret",
  fileScope: "scope",
  fileTokenCache: "tokenCachePath",
};

const AUDITOR_SCOPE: CredentialScope = {
  kind: "auditor",
  defaultScope: DEFAULT_AUDITOR_SCOPE,
  envBaseUrl: "VANTA_AUDITOR_BASE_URL",
  envClientId: "VANTA_AUDITOR_CLIENT_ID",
  envClientSecret: "VANTA_AUDITOR_CLIENT_SECRET",
  envScope: "VANTA_AUDITOR_SCOPE",
  envTokenCache: "VANTA_AUDITOR_TOKEN_CACHE_PATH",
  fileBaseUrl: "auditorBaseUrl",
  fileClientId: "auditorClientId",
  fileClientSecret: "auditorClientSecret",
  fileScope: "auditorScope",
  fileTokenCache: "auditorTokenCachePath",
};

export function loadConfig(options: LoadConfigOptions = {}): VantaConfig {
  return loadScopedConfig(MANAGE_SCOPE, options);
}

/** Loads credentials for Vanta's separately-scoped Auditor API application. */
export function loadAuditorConfig(options: LoadConfigOptions = {}): VantaConfig {
  return loadScopedConfig(AUDITOR_SCOPE, options);
}

function loadScopedConfig(scope: CredentialScope, options: LoadConfigOptions): VantaConfig {
  const env = options.env ?? process.env;
  const profile = options.profile ?? profileNameFromEnv(env);
  assertProfileSelectionIsUnambiguous(env, profile, options.configPath);

  const configPath = resolveConfigFilePath(env, options.configPath, profile);
  if (profile && !existsSync(configPath)) {
    throw new CliError(`No profile found: ${profile}`, 2);
  }
  const fileConfig = loadFileConfig(configPath);

  const envTokenCache = env[scope.envTokenCache]?.trim();
  const fileTokenCache = fileConfig[scope.fileTokenCache];
  const tokenCachePath = resolveUserPath(
    envTokenCache ||
      (typeof fileTokenCache === "string" ? fileTokenCache : undefined) ||
      defaultTokenCachePath(scope.kind, profile, env),
  );

  const envBaseUrl = env[scope.envBaseUrl]?.trim();
  const fileBaseUrl = fileConfig[scope.fileBaseUrl];
  const envClientId = env[scope.envClientId]?.trim();
  const fileClientId = fileConfig[scope.fileClientId];
  const envClientSecret = env[scope.envClientSecret]?.trim();
  const fileClientSecret = fileConfig[scope.fileClientSecret];
  const envScope = env[scope.envScope]?.trim();
  const fileScope = fileConfig[scope.fileScope];

  return {
    baseUrl: trimTrailingSlash(
      envBaseUrl || (typeof fileBaseUrl === "string" ? fileBaseUrl : undefined) || DEFAULT_BASE_URL,
    ),
    clientId: envClientId || (typeof fileClientId === "string" ? fileClientId : undefined),
    clientSecret:
      envClientSecret || (typeof fileClientSecret === "string" ? fileClientSecret : undefined),
    scope:
      envScope || (typeof fileScope === "string" ? fileScope : undefined) || scope.defaultScope,
    tokenCachePath,
    profile,
    configPath: configPathExists(configPath) ? configPath : undefined,
  };
}

export function requireCredentials(
  config: VantaConfig,
  errorMessage = "Missing Vanta credentials. Set VANTA_CLIENT_ID and VANTA_CLIENT_SECRET, or provide an ignored local config file.",
): {
  clientId: string;
  clientSecret: string;
} {
  if (!config.clientId || !config.clientSecret) {
    throw new Error(errorMessage);
  }
  return { clientId: config.clientId, clientSecret: config.clientSecret };
}

function resolveConfigFilePath(
  env: NodeJS.ProcessEnv,
  explicitConfigPath: string | undefined,
  profile: string | undefined,
): string {
  if (profile) return profileConfigPath(profile, env);
  if (explicitConfigPath) return resolveUserPath(explicitConfigPath);
  if (env.VANTA_CONFIG_PATH?.trim()) return resolveUserPath(env.VANTA_CONFIG_PATH.trim());
  return defaultConfigPath(env);
}

function configPathExists(path: string): boolean {
  return existsSync(path);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
