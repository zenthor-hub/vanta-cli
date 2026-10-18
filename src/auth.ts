import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";

import type { VantaConfig } from "./config.ts";
import { DEFAULT_TIMEOUT_MS, requireCredentials } from "./config.ts";
import { VantaApiError } from "./errors.ts";

const tokenSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().positive().optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

const cacheSchema = z.object({
  accessToken: z.string(),
  clientId: z.string().optional(),
  baseUrl: z.string(),
  scope: z.string(),
  expiresAt: z.number(),
});

export type TokenCache = z.infer<typeof cacheSchema>;

export type TokenCacheInspection = {
  cache?: TokenCache;
  error?: string;
};

export type TokenStatus = {
  configured: boolean;
  baseUrl: string;
  scope: string;
  tokenCachePath: string;
  cached?: {
    baseUrl: string;
    scope: string;
    expiresAt: number;
    expiresAtIso: string;
  };
  cacheUsable: boolean;
  cacheError?: string;
};

export type TokenManagerOptions = {
  config: VantaConfig;
  credentialErrorMessage?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  readCache?: (path: string) => TokenCache | undefined;
  writeCache?: (path: string, cache: TokenCache) => void;
  inspectCache?: (path: string) => TokenCacheInspection;
};

export class TokenManager {
  private readonly config: VantaConfig;
  private readonly credentialErrorMessage?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly readCache: (path: string) => TokenCache | undefined;
  private readonly writeCache: (path: string, cache: TokenCache) => void;
  private readonly inspectCache: (path: string) => TokenCacheInspection;
  private pending?: Promise<string>;

  public constructor(options: TokenManagerOptions) {
    this.config = options.config;
    this.credentialErrorMessage = options.credentialErrorMessage;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.readCache = options.readCache ?? readTokenCache;
    this.writeCache = options.writeCache ?? writeTokenCache;
    const injectedReadCache = options.readCache;
    this.inspectCache =
      options.inspectCache ??
      (injectedReadCache
        ? (path) => inspectInjectedCache(injectedReadCache, path)
        : inspectTokenCache);
  }

  public async getToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    if (!options.forceRefresh) {
      const cached = this.readCache(this.config.tokenCachePath);
      if (cached && this.isUsable(cached)) return cached.accessToken;
    }

    if (!this.pending) {
      this.pending = this.issueToken().finally(() => {
        this.pending = undefined;
      });
    }
    return this.pending;
  }

  public status(): TokenStatus {
    const inspection = this.inspectCache(this.config.tokenCachePath);
    const cached = inspection.cache;
    return {
      configured: Boolean(this.config.clientId && this.config.clientSecret),
      baseUrl: this.config.baseUrl,
      scope: this.config.scope,
      tokenCachePath: this.config.tokenCachePath,
      cached: cached
        ? {
            baseUrl: cached.baseUrl,
            scope: cached.scope,
            expiresAt: cached.expiresAt,
            expiresAtIso: new Date(cached.expiresAt).toISOString(),
          }
        : undefined,
      cacheUsable: Boolean(cached && this.isUsable(cached)),
      cacheError: inspection.error,
    };
  }

  private isUsable(cache: TokenCache): boolean {
    const skewMs = 60_000;
    return (
      Boolean(this.config.clientId) &&
      cache.clientId === this.config.clientId &&
      cache.baseUrl === this.config.baseUrl &&
      cache.scope === this.config.scope &&
      cache.expiresAt - skewMs > this.now()
    );
  }

  private async issueToken(): Promise<string> {
    const { clientId, clientSecret } = requireCredentials(this.config, this.credentialErrorMessage);
    const response = await this.fetchImpl(`${this.config.baseUrl}/oauth/token`, {
      signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        scope: this.config.scope,
        grant_type: "client_credentials",
      }),
    });

    const body = await readResponseBody(response);
    if (!response.ok) throw new VantaApiError(response.status, body, "Token exchange failed");

    const token = tokenSchema.parse(body);
    const expiresInMs = (token.expires_in ?? 3600) * 1000;
    const cache: TokenCache = {
      accessToken: token.access_token,
      clientId,
      baseUrl: this.config.baseUrl,
      scope: this.config.scope,
      expiresAt: this.now() + expiresInMs,
    };
    this.writeCache(this.config.tokenCachePath, cache);
    return cache.accessToken;
  }
}

export function readTokenCache(path: string): TokenCache | undefined {
  return inspectTokenCache(path).cache;
}

export function inspectTokenCache(path: string): TokenCacheInspection {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return { cache: cacheSchema.parse(parsed) };
  } catch {
    return { error: "Token cache is malformed or unreadable." };
  }
}

export function writeTokenCache(path: string, cache: TokenCache): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function redactToken(token: string): string {
  if (token.length <= 12) return "<redacted>";
  return `${token.slice(0, 6)}...${token.slice(-6)}`;
}

function inspectInjectedCache(
  readCache: (path: string) => TokenCache | undefined,
  path: string,
): TokenCacheInspection {
  try {
    return { cache: readCache(path) };
  } catch {
    return { error: "Token cache is malformed or unreadable." };
  }
}
