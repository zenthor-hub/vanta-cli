import { Command } from "commander";

import {
  listAuditCodeChanges,
  parseCodeChangeDate,
  parseCodeChangeMaxPages,
  parseCodeChangePageSize,
  parseCodeChangeSources,
} from "../audits.ts";
import { runAuditor } from "../cli-run.ts";
import { collect, parseQueryOptions } from "../io.ts";
import { parseMaxPages, requestAllPages } from "../pagination.ts";

export function registerAuditCommands(program: Command): void {
  const audits = program.command("audits").description("Read-only Auditor API commands");
  collection(
    audits.command("list").description("List audits, including soft-deleted records"),
  ).action(async function (this: Command, options: CollectionOptions) {
    await readCollection(this, "/v1/audits", options);
  });
  audits
    .command("get")
    .description("Get an audit")
    .argument("<auditId>")
    .action(async function (this: Command, auditId: string) {
      await runAuditor(this, ({ client }) => client.request({ path: auditPath(auditId) }));
    });

  const controls = audits.command("controls").description("Audit controls");
  collection(
    controls.command("list").description("List audit controls").argument("<auditId>"),
  ).action(async function (this: Command, auditId: string, options: CollectionOptions) {
    await readCollection(this, `${auditPath(auditId)}/controls`, options);
  });

  const evidence = audits
    .command("evidence")
    .description("Audit evidence, including deleted records");
  collection(
    evidence.command("list").description("List audit evidence").argument("<auditId>"),
  ).action(async function (this: Command, auditId: string, options: CollectionOptions) {
    await readCollection(this, `${auditPath(auditId)}/evidence`, options);
  });
  evidence
    .command("get")
    .description("Get audit evidence")
    .argument("<auditId>")
    .argument("<evidenceId>")
    .action(async function (this: Command, auditId: string, evidenceId: string) {
      await runAuditor(this, ({ client }) =>
        client.request({
          path: `${auditPath(auditId)}/evidence/${encodeURIComponent(evidenceId)}`,
        }),
      );
    });
  collection(
    evidence
      .command("urls")
      .description(
        "Get short-lived signed evidence URLs; requires exactly one audit program segment",
      )
      .argument("<auditId>")
      .argument("<evidenceId>"),
  ).action(async function (
    this: Command,
    auditId: string,
    evidenceId: string,
    options: CollectionOptions,
  ) {
    await readCollection(
      this,
      `${auditPath(auditId)}/evidence/${encodeURIComponent(evidenceId)}/urls`,
      options,
    );
  });

  const requests = audits.command("information-requests").description("Audit information requests");
  collection(
    requests.command("list").description("List audit information requests").argument("<auditId>"),
  ).action(async function (this: Command, auditId: string, options: CollectionOptions) {
    await readCollection(this, `${auditPath(auditId)}/information-requests`, options);
  });
  requests
    .command("get")
    .description("Get an audit information request")
    .argument("<auditId>")
    .argument("<requestId>")
    .action(async function (this: Command, auditId: string, requestId: string) {
      await runAuditor(this, ({ client }) =>
        client.request({
          path: `${auditPath(auditId)}/information-requests/${encodeURIComponent(requestId)}`,
        }),
      );
    });

  const codeChanges = audits
    .command("code-changes")
    .description("Code changes associated with an audit");
  codeChanges
    .command("list")
    .description("List code changes for an audit")
    .argument("<auditId>")
    .option("--search <term>", "case-insensitive title or repository search")
    .option(
      "--source <source>",
      "github, gitlab, bitbucket, or azuredevops; repeatable",
      collect,
      [],
    )
    .option("--closed-after <date-time>", "only changes closed after this RFC 3339 date-time")
    .option("--closed-before <date-time>", "only changes closed before this RFC 3339 date-time")
    .option(
      "--repository <repository>",
      "exact repository match, applied locally while scanning all bounded pages",
    )
    .option("--page-size <number>", "results per page, from 1 to 100")
    .option("--page-cursor <cursor>", "pagination cursor")
    .option("--all", "fetch all pages within --max-pages")
    .option("--max-pages <number>", "maximum pages with --all or --repository, from 1 to 100", "50")
    .action(async function (
      this: Command,
      auditId: string,
      options: {
        search?: string;
        source: string[];
        closedAfter?: string;
        closedBefore?: string;
        repository?: string;
        pageSize?: string;
        pageCursor?: string;
        maxPages: string;
        all?: boolean;
      },
    ) {
      await runAuditor(this, ({ client }) =>
        listAuditCodeChanges(client, auditId, {
          search: options.search,
          sources: parseCodeChangeSources(options.source),
          closedAfterDate: parseCodeChangeDate(options.closedAfter, "--closed-after"),
          closedBeforeDate: parseCodeChangeDate(options.closedBefore, "--closed-before"),
          repository: options.repository,
          pageSize: parseCodeChangePageSize(options.pageSize),
          pageCursor: options.pageCursor,
          maxPages: parseCodeChangeMaxPages(options.maxPages),
          all: options.all,
        }),
      );
    });
}

type CollectionOptions = { query: string[]; all?: boolean; maxPages: string };

function collection(command: Command): Command {
  return command
    .option("--query <key=value>", "query filter, repeatable", collect, [])
    .option("--all", "scan all pages from the optional starting cursor")
    .option("--max-pages <number>", "maximum pages with --all, from 1 to 100", "100");
}

function auditPath(auditId: string): string {
  return `/v1/audits/${encodeURIComponent(auditId)}`;
}

async function readCollection(
  command: Command,
  path: string,
  options: CollectionOptions,
): Promise<void> {
  const query = parseQueryOptions(options.query);
  const maxPages = parseMaxPages(options.maxPages);
  await runAuditor(command, ({ client }) =>
    options.all
      ? requestAllPages(client, path, query, { maxPages })
      : client.request({ path, query }),
  );
}
