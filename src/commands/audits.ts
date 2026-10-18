import { Command } from "commander";

import {
  listAuditCodeChanges,
  parseCodeChangeDate,
  parseCodeChangeMaxPages,
  parseCodeChangePageSize,
  parseCodeChangeSources,
} from "../audits.ts";
import { runAuditor } from "../cli-run.ts";
import { collect } from "../io.ts";

export function registerAuditCommands(program: Command): void {
  const audits = program.command("audits").description("Read-only Auditor API commands");
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
