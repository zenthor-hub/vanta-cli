import { createInterface } from "node:readline/promises";
import { readFileSync } from "node:fs";

import { stdin as input, stdout as output, stderr } from "node:process";

import { CliError } from "./errors.ts";

export type GlobalOptions = {
  json?: boolean;
  yes?: boolean;
  apply?: boolean;
  debug?: boolean;
  config?: string;
  profile?: string;
  timeoutMs?: string;
};

export function printResult(data: unknown, options: GlobalOptions): void {
  if (data instanceof Uint8Array) {
    if (options.json) throw new CliError("Use --output <path> for downloads with --json.");
    output.write(data);
    return;
  }
  if (options.json) {
    output.write(`${JSON.stringify(data ?? null, null, 2)}\n`);
    return;
  }
  output.write(`${formatHuman(data)}\n`);
}

export async function confirmWrite(summary: string, options: GlobalOptions): Promise<void> {
  if (options.yes) return;
  console.error(summary);
  const rl = createInterface({ input, output: stderr });
  try {
    stderr.write("Proceed? Type yes to continue: ");
    for await (const answer of rl) {
      if (answer.trim().toLowerCase() !== "yes") throw new CliError("Aborted.", 2);
      return;
    }
    throw new CliError("Aborted: no confirmation received.", 2);
  } finally {
    rl.close();
  }
}

export function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

export function parseJsonOption(value?: string): unknown {
  if (!value) return undefined;
  return JSON.parse(value);
}

export function parseBodyInput(options: { body?: string; bodyFile?: string }): unknown {
  if (options.body !== undefined && options.bodyFile !== undefined) {
    throw new CliError("Use either --body or --body-file, not both.");
  }
  const bodyText = options.bodyFile ? readFileSync(options.bodyFile, "utf8") : options.body;
  return parseJsonOption(bodyText);
}

export function parseQueryOptions(values: string[]): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const value of values) {
    const [key, ...rest] = value.split("=");
    if (!key || rest.length === 0) throw new CliError(`Invalid query parameter: ${value}`);
    const parsed = rest.join("=");
    const existing = query[key];
    if (existing === undefined) {
      query[key] = parsed;
    } else if (Array.isArray(existing)) {
      existing.push(parsed);
    } else {
      query[key] = [existing, parsed];
    }
  }
  return query;
}

function formatHuman(data: unknown): string {
  if (data === undefined) return "OK";
  if (typeof data === "string") return data;
  return JSON.stringify(data, null, 2);
}
