import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";

import { CliError } from "./errors.ts";

export const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "vanta-cli");
export const DEFAULT_PROFILES_DIR = join(DEFAULT_CONFIG_DIR, "profiles");
export const DEFAULT_CACHE_DIR = join(DEFAULT_CONFIG_DIR, "cache");

/** Legacy default config path (still read for non-profile mode). */
export const LEGACY_CONFIG_PATH = join(homedir(), ".vanta-cli.json");
export const LEGACY_TOKEN_CACHE_PATH = join(homedir(), ".vanta-token-cache.json");
export const LEGACY_AUDITOR_TOKEN_CACHE_PATH = join(homedir(), ".vanta-auditor-token-cache.json");

export const fileConfigSchema = z
  .object({
    baseUrl: z.string().url().optional(),
    scope: z.string().min(1).optional(),
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    tokenCachePath: z.string().min(1).optional(),
    auditorBaseUrl: z.string().url().optional(),
    auditorScope: z.string().min(1).optional(),
    auditorClientId: z.string().min(1).optional(),
    auditorClientSecret: z.string().min(1).optional(),
    auditorTokenCachePath: z.string().min(1).optional(),
  })
  .strict();

export type FileConfig = z.infer<typeof fileConfigSchema>;

export function resolveUserPath(path: string): string {
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

export function profileNameFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const name = env.VANTA_PROFILE?.trim();
  return name || undefined;
}

export function profilesDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveUserPath(env.VANTA_PROFILES_DIR ?? DEFAULT_PROFILES_DIR);
}

export function assertProfileName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new CliError(
      "Profile name must start with a letter or digit and contain only letters, digits, '.', '_' or '-'.",
      2,
    );
  }
}

export function profileConfigPath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  assertProfileName(name);
  return join(profilesDir(env), `${name}.json`);
}

export function defaultConfigPath(_env: NodeJS.ProcessEnv = process.env): string {
  const modern = join(DEFAULT_CONFIG_DIR, "config.json");
  if (existsSync(modern)) return modern;
  return LEGACY_CONFIG_PATH;
}

export function defaultTokenCachePath(
  kind: "manage" | "auditor",
  profile: string | undefined,
  _env: NodeJS.ProcessEnv = process.env,
): string {
  if (profile) {
    const suffix = kind === "auditor" ? `${profile}-auditor.json` : `${profile}.json`;
    return join(DEFAULT_CACHE_DIR, suffix);
  }
  const modern =
    kind === "auditor"
      ? join(DEFAULT_CACHE_DIR, "default-auditor.json")
      : join(DEFAULT_CACHE_DIR, "default.json");
  if (existsSync(modern)) return modern;
  return kind === "auditor" ? LEGACY_AUDITOR_TOKEN_CACHE_PATH : LEGACY_TOKEN_CACHE_PATH;
}

export function loadFileConfig(path: string): FileConfig {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return fileConfigSchema.parse(parsed);
}

export function listProfiles(env: NodeJS.ProcessEnv = process.env): Array<{
  name: string;
  path: string;
  hasClientId: boolean;
  hasAuditor: boolean;
}> {
  const dir = profilesDir(env);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const name = file.replace(/\.json$/, "");
      const path = join(dir, file);
      const parsed = loadFileConfig(path);
      return {
        name,
        path,
        hasClientId: Boolean(parsed.clientId),
        hasAuditor: Boolean(parsed.auditorClientId),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function saveProfile(
  name: string,
  config: FileConfig,
  options: { replace?: boolean; env?: NodeJS.ProcessEnv } = {},
): string {
  assertProfileName(name);
  const env = options.env ?? process.env;
  const path = profileConfigPath(name, env);
  if (existsSync(path) && !options.replace) {
    throw new CliError(`Profile \`${name}\` already exists. Pass --replace to overwrite it.`, 2);
  }
  mkdirSync(profilesDir(env), { recursive: true });
  const validated = fileConfigSchema.parse(config);
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function removeProfile(name: string, env: NodeJS.ProcessEnv = process.env): string {
  assertProfileName(name);
  const path = profileConfigPath(name, env);
  if (!existsSync(path)) {
    throw new CliError(`No profile found: ${name}`, 2);
  }
  unlinkSync(path);
  return path;
}

export function assertProfileSelectionIsUnambiguous(
  env: NodeJS.ProcessEnv,
  profile: string | undefined,
  explicitConfigPath: string | undefined,
): void {
  if (!profile) return;
  if (
    env.VANTA_CLIENT_ID?.trim() ||
    env.VANTA_CLIENT_SECRET?.trim() ||
    env.VANTA_AUDITOR_CLIENT_ID?.trim() ||
    env.VANTA_AUDITOR_CLIENT_SECRET?.trim() ||
    env.VANTA_CONFIG_PATH?.trim() ||
    explicitConfigPath
  ) {
    throw new CliError(
      "A selected profile cannot be combined with Manage or Auditor credential environment variables, VANTA_CONFIG_PATH, or --config.",
      2,
    );
  }
}
