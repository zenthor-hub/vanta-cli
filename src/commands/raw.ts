import { Command } from "commander";

import { globalsFrom, run, runLocal } from "../cli-run.ts";
import { CliError } from "../errors.ts";
import { collect, confirmWrite, parseBodyInput, parseQueryOptions } from "../io.ts";
import { parseMultipart } from "../multipart.ts";

type RawOptions = {
  query: string[];
  body?: string;
  bodyFile?: string;
  form: string[];
  file: string[];
  fileType: string[];
  output?: string;
  force?: boolean;
};

export function registerRawCommand(program: Command): void {
  program
    .command("raw")
    .description("Call an unsupported Manage API endpoint")
    .argument("<method>", "HTTP method")
    .argument("<path>", "exact API path, including /v1")
    .option("--query <key=value>", "query parameter, repeatable", collect, [])
    .option("--body <json>", "JSON request body")
    .option("--body-file <path>", "read JSON request body from file")
    .option("--form <key=value>", "multipart text field, repeatable (POST/PUT/PATCH)", collect, [])
    .option("--file <field=path>", "multipart file field, repeatable", collect, [])
    .option(
      "--file-type <field=mime>",
      "override a file MIME type (fallback application/octet-stream)",
      collect,
      [],
    )
    .option("--output <path>", "save exact response bytes to a file (GET only)")
    .option("--force", "atomically replace an existing --output file")
    .action(async function (this: Command, method: string, path: string, options: RawOptions) {
      const upperMethod = method.toUpperCase();
      const hasMultipart = options.form.length > 0 || options.file.length > 0;
      if (hasMultipart && (options.body !== undefined || options.bodyFile !== undefined)) {
        throw new CliError("JSON body options cannot combine with multipart fields or files.");
      }
      if (hasMultipart && !["POST", "PUT", "PATCH"].includes(upperMethod)) {
        throw new CliError("Multipart requires POST, PUT, or PATCH.");
      }
      if (options.output !== undefined && upperMethod !== "GET")
        throw new CliError("--output requires GET.");
      if (options.force && options.output === undefined)
        throw new CliError("--force requires --output.");
      if (
        options.output !== undefined &&
        (options.body !== undefined || options.bodyFile !== undefined || hasMultipart)
      ) {
        throw new CliError("--output cannot combine with request body options.");
      }
      const parts = parseMultipart(options);
      const body = parseBodyInput(options);
      const query = parseQueryOptions(options.query);
      const request = {
        method: upperMethod,
        path,
        query,
        ...(hasMultipart ? { parts } : { body }),
      };
      const isMutation = !["GET", "HEAD", "OPTIONS"].includes(upperMethod);
      const globals = globalsFrom(this);
      if (isMutation && !globals.apply) {
        await runLocal(this, () => ({
          dryRun: true,
          mutation: true,
          requiresApply: true,
          confirmationRequired: !globals.yes,
          summary: `${upperMethod} ${path}`,
          request,
          guidance: "Pass --apply to execute this mutation.",
        }));
        return;
      }
      await run(this, async ({ client }) => {
        if (isMutation) await confirmWrite(`${upperMethod} ${path}`, globals);
        if (options.output !== undefined)
          return client.download(path, options.output, { force: options.force, query });
        if (hasMultipart) return client.multipart({ method: upperMethod, path, query, parts });
        return client.request({ method: upperMethod, path, query, body });
      });
    });
}
