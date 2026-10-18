import { createInterface } from "node:readline/promises";
import { stdin as input, stderr } from "node:process";

import { Command } from "commander";

import { redactToken, type TokenStatus } from "../auth.ts";
import { listProfiles, removeProfile, saveProfile } from "../config.ts";
import { run, runLocal } from "../cli-run.ts";
import { CliError } from "../errors.ts";

export function registerAuthCommands(program: Command): void {
  const auth = program.command("auth").description("Authentication");

  auth
    .command("token")
    .description("Mint or reuse an access token")
    .option("--force-refresh", "ignore cached token and request a new one")
    .option("--reveal-token", "print the full access token")
    .action(async function (
      this: Command,
      options: { forceRefresh?: boolean; revealToken?: boolean },
    ) {
      await run(this, async ({ tokenManager }) => {
        const token = await tokenManager.getToken({ forceRefresh: options.forceRefresh });
        const status = tokenManager.status();
        return formatTokenOutput(token, status, Boolean(options.revealToken));
      });
    });

  auth
    .command("status")
    .description("Show credential and token-cache status")
    .action(async function (this: Command) {
      await run(this, async ({ tokenManager, config }) => ({
        ...tokenManager.status(),
        profile: config.profile,
        configPath: config.configPath,
      }));
    });

  const profileCmd = auth.command("profile").description("Named credential profiles");
  profileCmd
    .command("list")
    .description("List stored credential profiles without exposing secrets")
    .action(async function (this: Command) {
      await runLocal(this, () => listProfiles());
    });

  profileCmd
    .command("add")
    .description(
      "Save Manage API credentials into a named profile (client ID from flag/env; secret from env or stdin)",
    )
    .requiredOption("--name <name>", "profile name")
    .option("--client-id <id>", "Vanta client ID (defaults to VANTA_CLIENT_ID)")
    .option("--scope <scope>", "OAuth scope")
    .option("--base-url <url>", "API base URL")
    .option("--replace", "overwrite an existing profile with the same name")
    .action(async function (
      this: Command,
      options: {
        name: string;
        clientId?: string;
        scope?: string;
        baseUrl?: string;
        replace?: boolean;
      },
    ) {
      await runLocal(this, async () => {
        const clientId = options.clientId ?? process.env.VANTA_CLIENT_ID?.trim();
        const clientSecret = await readClientSecret();
        if (!clientId || !clientSecret) {
          throw new CliError(
            "Provide --client-id (or VANTA_CLIENT_ID) and VANTA_CLIENT_SECRET or a secret on stdin.",
            2,
          );
        }
        const path = saveProfile(
          options.name,
          {
            clientId,
            clientSecret,
            scope: options.scope,
            baseUrl: options.baseUrl,
          },
          { replace: options.replace },
        );
        return { name: options.name, path, saved: true };
      });
    });

  profileCmd
    .command("remove")
    .description("Remove a named credential profile")
    .requiredOption("--name <name>", "profile name")
    .action(async function (this: Command, options: { name: string }) {
      await runLocal(this, () => {
        const path = removeProfile(options.name);
        return { name: options.name, path, removed: true };
      });
    });
}

/**
 * Prefer VANTA_CLIENT_SECRET env. If unset and stdin is a pipe, read one line.
 * Never accept secrets via long-lived argv flags.
 */
export async function readClientSecret(
  env: NodeJS.ProcessEnv = process.env,
  stdin: NodeJS.ReadStream = input,
): Promise<string | undefined> {
  const fromEnv = env.VANTA_CLIENT_SECRET?.trim();
  if (fromEnv) return fromEnv;
  if (stdin.isTTY) return undefined;

  const rl = createInterface({ input: stdin, output: stderr, terminal: false });
  try {
    for await (const line of rl) {
      return line.trim() || undefined;
    }
    return undefined;
  } finally {
    rl.close();
  }
}

export function formatTokenOutput(
  token: string,
  status: TokenStatus,
  revealToken: boolean,
): {
  accessToken: string;
  redacted: boolean;
  baseUrl: string;
  scope: string;
  expiresAt?: number;
  expiresAtIso?: string;
} {
  return {
    accessToken: revealToken ? token : redactToken(token),
    redacted: !revealToken,
    baseUrl: status.baseUrl,
    scope: status.scope,
    expiresAt: status.cached?.expiresAt,
    expiresAtIso: status.cached?.expiresAtIso,
  };
}
