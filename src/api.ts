import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { TokenManager } from "./auth.ts";
import { DEFAULT_TIMEOUT_MS, type VantaConfig } from "./config.ts";
import { CliError, VantaApiError } from "./errors.ts";
import {
  computeBackoffMs,
  DEFAULT_BACKOFF,
  isIdempotentMethod,
  RETRYABLE_STATUS,
  sleep,
  type BackoffConfig,
} from "./retry.ts";

export type RequestOptions = {
  method?: string;
  path: string;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Override default retry behavior for this request. */
  maxRetries?: number;
};

export class VantaClient {
  private readonly config: VantaConfig;
  private readonly tokenManager: TokenManager;
  private readonly fetchImpl: typeof fetch;
  private readonly backoff: BackoffConfig;

  public constructor(options: {
    config: VantaConfig;
    tokenManager: TokenManager;
    fetchImpl?: typeof fetch;
    backoff?: Partial<BackoffConfig>;
  }) {
    this.config = options.config;
    this.tokenManager = options.tokenManager;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
  }

  public async request<T = unknown>(options: RequestOptions): Promise<T> {
    const method = (options.method ?? "GET").toUpperCase();
    const canRetry = isIdempotentMethod(method);
    const maxRetries = options.maxRetries ?? this.backoff.maxRetries;

    for (let attempt = 0; ; attempt++) {
      const token = await this.tokenManager.getToken();
      const response = await this.fetchImpl(this.url(options.path, options.query), {
        signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });

      if (canRetry && RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
        const delay = computeBackoffMs(attempt, response.headers.get("retry-after"), this.backoff);
        await sleep(delay);
        continue;
      }

      return readApiResponse<T>(response);
    }
  }

  public async upload(
    path: string,
    filePath: string,
    fields: { description?: string; effectiveAtDate?: string } = {},
  ): Promise<unknown> {
    const token = await this.tokenManager.getToken();
    const form = new FormData();
    form.append("file", new Blob([readFileSync(filePath)]), filePath.split("/").at(-1) ?? "file");
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) form.append(key, value);
    }
    const response = await this.fetchImpl(this.url(path), {
      signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      body: form,
    });
    return readApiResponse(response);
  }

  public async download(
    path: string,
    outputPath?: string,
    options: { force?: boolean } = {},
  ): Promise<unknown> {
    if (outputPath && existsSync(outputPath) && !options.force) {
      throw new CliError(
        `Output file already exists: ${outputPath}. Pass --force to overwrite it.`,
      );
    }
    const token = await this.tokenManager.getToken();
    const response = await this.fetchImpl(this.url(path), {
      signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new VantaApiError(response.status, await readBody(response));
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (outputPath) {
      writeFileSync(outputPath, bytes);
      return { outputPath, bytes: bytes.byteLength };
    }
    return bytes;
  }

  private url(path: string, query?: Record<string, string | string[] | undefined>): string {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${this.config.baseUrl}${normalized}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, item);
      } else {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }
}

export async function readApiResponse<T>(response: Response): Promise<T> {
  const body = await readBody(response);
  if (!response.ok) throw new VantaApiError(response.status, body);
  return body as T;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return JSON.parse(text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
