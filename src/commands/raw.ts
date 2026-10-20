import { Command } from "commander";

import { globalsFrom, run, runAuditor, runLocal } from "../cli-run.ts";
import { CliError } from "../errors.ts";
import { collect, confirmWrite, parseBodyInput, parseQueryOptions } from "../io.ts";
import { parseMultipart } from "../multipart.ts";
import { parseMaxPages, requestAllPages } from "../pagination.ts";

type RawOptions = {
  api: string;
  query: string[];
  body?: string;
  bodyFile?: string;
  form: string[];
  file: string[];
  fileType: string[];
  output?: string;
  force?: boolean;
  all?: boolean;
  maxPages: string;
};

export function registerRawCommand(program: Command): void {
  program
    .command("raw")
    .description("Call an exact Manage endpoint or read an Auditor endpoint")
    .argument("<method>", "HTTP method")
    .argument("<path>", "exact API path, including /v1")
    .option("--api <api>", "manage or auditor (Auditor is GET-only)", "manage")
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
    .option("--all", "scan GET collections from the optional starting cursor")
    .option("--max-pages <number>", "maximum pages with --all, from 1 to 100", "100")
    .action(async function (this: Command, method: string, path: string, options: RawOptions) {
      const upperMethod = method.toUpperCase();
      if (!["manage", "auditor"].includes(options.api))
        throw new CliError("--api must be manage or auditor.");
      if (options.api === "auditor") {
        if (upperMethod !== "GET") throw new CliError("Auditor raw supports GET only.");
        if (!path.startsWith("/v1/"))
          throw new CliError("Auditor raw requires an exact /v1/ path.");
        if (
          options.body !== undefined ||
          options.bodyFile !== undefined ||
          options.form.length > 0 ||
          options.file.length > 0 ||
          options.fileType.length > 0 ||
          options.output !== undefined ||
          options.force
        ) {
          throw new CliError(
            "Auditor raw does not support request bodies, multipart, or file output.",
          );
        }
      }
      const hasMultipart = options.form.length > 0 || options.file.length > 0;
      const maxPages = parseMaxPages(options.maxPages);
      if (options.all && upperMethod !== "GET") throw new CliError("--all requires GET.");
      if (
        options.all &&
        (options.body !== undefined ||
          options.bodyFile !== undefined ||
          hasMultipart ||
          options.fileType.length > 0 ||
          options.output !== undefined ||
          options.force)
      ) {
        throw new CliError("--all cannot combine with request bodies, multipart, or file output.");
      }
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
      const runRequest = options.api === "auditor" ? runAuditor : run;
      await runRequest(this, async ({ client }) => {
        if (options.all) return requestAllPages(client, path, query, { maxPages });
        if (isMutation) await confirmWrite(`${upperMethod} ${path}`, globals);
        if (options.output !== undefined)
          return client.download(path, options.output, { force: options.force, query });
        if (hasMultipart) return client.multipart({ method: upperMethod, path, query, parts });
        return client.request({ method: upperMethod, path, query, body });
      });
    });
}
