import { Command } from "commander";

import { TokenManager } from "./auth.ts";
import { VantaClient } from "./api.ts";
import { loadAuditorConfig, loadConfig, parseTimeoutMs, type VantaConfig } from "./config.ts";
import { CliError, VantaApiError, formatError, formatJsonError } from "./errors.ts";
import { printResult, type GlobalOptions } from "./io.ts";

export type CliContext = {
  globals: GlobalOptions;
  config: VantaConfig;
  client: VantaClient;
  tokenManager: TokenManager;
};

const AUDITOR_CREDENTIAL_ERROR =
  "Missing Vanta Auditor API credentials. Set VANTA_AUDITOR_CLIENT_ID and VANTA_AUDITOR_CLIENT_SECRET, or provide an ignored local config file.";

export function exitCodeForError(error: unknown): number {
  return error instanceof CliError ? error.exitCode : 1;
}

export function globalsFrom(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

/**
 * Shared error/print path for all commands. Does not mutate process.env.
 */
export async function runCommand(
  globals: GlobalOptions,
  body: () => Promise<unknown>,
): Promise<void> {
  try {
    const result = await body();
    printResult(result, globals);
  } catch (error) {
    reportError(error, globals);
  }
}

export function reportError(error: unknown, globals: GlobalOptions): void {
  const jsonError = formatJsonError(error);
  const rendered = globals.json
    ? JSON.stringify(
        {
          ...jsonError,
          error: {
            ...jsonError.error,
            ...(globals.debug && error instanceof Error ? { stack: error.stack } : {}),
          },
        },
        null,
        2,
      )
    : formatError(error);
  process.stderr.write(`${rendered}\n`);
  if (!globals.json && globals.debug && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = exitCodeForError(error);
}

export async function run(
  command: Command,
  operation: (context: CliContext) => Promise<unknown>,
): Promise<void> {
  await runWithLoader(command, loadConfig, operation);
}

export async function runAuditor(
  command: Command,
  operation: (context: CliContext) => Promise<unknown>,
): Promise<void> {
  await runWithLoader(
    command,
    loadAuditorConfig,
    async (context) => {
      try {
        return await operation(context);
      } catch (error) {
        if (error instanceof VantaApiError) {
          // Auditor error payloads can contain bearer evidence URLs.
          throw new VantaApiError(
            error.status,
            undefined,
            `Vanta Auditor API request failed with status ${error.status}`,
            "auditor",
          );
        }
        throw error;
      }
    },
    AUDITOR_CREDENTIAL_ERROR,
  );
}

/** Local ops that do not need Vanta API credentials (e.g. profile list/remove). */
export async function runLocal(
  command: Command,
  operation: () => unknown | Promise<unknown>,
): Promise<void> {
  const globals = globalsFrom(command);
  await runCommand(globals, async () => operation());
}

async function runWithLoader(
  command: Command,
  load: (options: { configPath?: string; profile?: string }) => VantaConfig,
  operation: (context: CliContext) => Promise<unknown>,
  credentialErrorMessage?: string,
): Promise<void> {
  const globals = globalsFrom(command);
  await runCommand(globals, async () => {
    const config = load({
      configPath: globals.config,
      profile: globals.profile,
    });
    config.timeoutMs = parseTimeoutMs(globals.timeoutMs);
    const tokenManager = new TokenManager({ config, credentialErrorMessage });
    const client = new VantaClient({ config, tokenManager });
    return operation({ globals, config, client, tokenManager });
  });
}
