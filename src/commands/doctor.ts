import { existsSync, statSync } from "node:fs";
import { Command } from "commander";

import type { TokenManager } from "../auth.ts";
import type { VantaClient } from "../api.ts";
import { run } from "../cli-run.ts";
import { formatError } from "../errors.ts";

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Run read-only configuration and credential diagnostics")
    .action(async function (this: Command) {
      await run(this, async ({ client, tokenManager }) => doctor(client, tokenManager));
    });
}

async function doctor(client: VantaClient, tokenManager: TokenManager): Promise<unknown> {
  const status = tokenManager.status();
  const tokenCache = {
    path: status.tokenCachePath,
    exists: existsSync(status.tokenCachePath),
    mode: fileMode(status.tokenCachePath),
    usable: status.cacheUsable,
    cached: status.cached,
    error: status.cacheError,
  };
  const api = status.configured
    ? await readOnlyApiCheck(client)
    : { checked: false, ok: false, reason: "credentials_not_configured" };

  return {
    configured: status.configured,
    baseUrl: status.baseUrl,
    scope: status.scope,
    tokenCache,
    api,
  };
}

function fileMode(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return `0o${(statSync(path).mode & 0o777).toString(8).padStart(3, "0")}`;
}

async function readOnlyApiCheck(client: VantaClient): Promise<unknown> {
  try {
    await client.request({ path: "/v1/frameworks", query: { pageSize: "1" } });
    return { checked: true, ok: true, path: "/v1/frameworks", query: { pageSize: "1" } };
  } catch (error) {
    return {
      checked: true,
      ok: false,
      path: "/v1/frameworks",
      query: { pageSize: "1" },
      error: formatError(error),
    };
  }
}
