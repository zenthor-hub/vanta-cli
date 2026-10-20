import { Command } from "commander";

import type { RequestOptions, VantaClient } from "../api.ts";
import { assertSingleTargetBulkResult } from "../bulk-result.ts";
import { run } from "../cli-run.ts";
import { collect, confirmWrite, parseQueryOptions } from "../io.ts";
import { parseMaxPages, requestAllPages } from "../pagination.ts";
import {
  findRemediation,
  readVulnerabilityState,
  requireNonempty,
  vulnerabilityDeactivationUpdate,
} from "../vulnerabilities.ts";

type PreparedMutation = { kind: "ready"; summary: string } | { kind: "unchanged" };
type MutationPlan = {
  id: string;
  summary: string;
  request: RequestOptions;
  prepare: (client: VantaClient) => Promise<PreparedMutation>;
};

export function registerVulnerabilityCommands(vulnerabilities: Command): void {
  vulnerabilities
    .command("deactivate")
    .description("Deactivate monitoring with an explicit reactivation policy")
    .argument("<id>")
    .requiredOption("--reason <reason>", "reason for the exception")
    .requiredOption("--reactivate-when-fixable <boolean>", "true or false; required")
    .option(
      "--until <date-time>",
      "future RFC 3339 expiry; omitted expiry follows the API contract",
    )
    .action(async function (
      this: Command,
      id: string,
      options: { reason: string; reactivateWhenFixable: string; until?: string },
    ) {
      await mutate(this, () => {
        const update = vulnerabilityDeactivationUpdate({ id, ...options });
        const summary = `Deactivate vulnerability ${update.id}. Reason: ${update.deactivateReason}. Reactivate when fixable: ${update.shouldReactivateWhenFixable}. Expiry: ${options.until ?? "omitted from request"}.`;
        return {
          id: update.id,
          summary,
          request: {
            method: "POST",
            path: "/v1/vulnerabilities/deactivate",
            body: { updates: [update] },
          },
          async prepare(client) {
            const target = await readVulnerabilityState(client, update.id);
            return { kind: "ready", summary: `${target.name}. ${summary}` };
          },
        };
      });
    });

  vulnerabilities
    .command("reactivate")
    .description("Reactivate monitoring for a vulnerability")
    .argument("<id>")
    .action(async function (this: Command, id: string) {
      await mutate(this, () => {
        id = requireNonempty(id, "Vulnerability ID");
        const summary = `Reactivate vulnerability ${id}.`;
        return {
          id,
          summary,
          request: {
            method: "POST",
            path: "/v1/vulnerabilities/reactivate",
            body: { updates: [{ id }] },
          },
          async prepare(client) {
            const target = await readVulnerabilityState(client, id);
            return target.deactivateMetadata === null
              ? { kind: "unchanged" }
              : { kind: "ready", summary: `${target.name}. ${summary}` };
          },
        };
      });
    });

  const assets = vulnerabilities
    .command("assets")
    .description("Assets monitored for vulnerabilities");
  registerList(assets, "/v1/vulnerable-assets");
  assets
    .command("get")
    .description("Get a vulnerable asset")
    .argument("<assetId>")
    .action(async function (this: Command, assetId: string) {
      await run(this, ({ client }) =>
        client.request({ path: `/v1/vulnerable-assets/${encodeURIComponent(assetId)}` }),
      );
    });

  const remediations = vulnerabilities
    .command("remediations")
    .description("Vulnerability remediation records");
  registerList(remediations, "/v1/vulnerability-remediations");
  remediations
    .command("acknowledge-sla-miss")
    .description(
      "Acknowledge an SLA miss after a bounded existence lookup; Vanta checks eligibility",
    )
    .argument("<remediationId>")
    .requiredOption("--comment <comment>", "why the SLA was missed")
    .option("--query <key=value>", "narrow the apply-time existence scan; repeatable", collect, [])
    .option("--max-pages <number>", "maximum lookup pages, from 1 to 100", "100")
    .action(async function (
      this: Command,
      remediationId: string,
      options: { comment: string; query: string[]; maxPages: string },
    ) {
      await mutate(this, () => {
        const id = requireNonempty(remediationId, "Remediation ID");
        const slaViolationComment = requireNonempty(options.comment, "--comment");
        const query = parseQueryOptions(options.query);
        const maxPages = parseMaxPages(options.maxPages);
        const summary = `Acknowledge SLA miss for remediation ${id}. Comment: ${slaViolationComment}. Vanta checks eligibility.`;
        return {
          id,
          summary,
          request: {
            method: "POST",
            path: "/v1/vulnerability-remediations/acknowledge-sla-miss",
            body: { updates: [{ id, slaViolationComment }] },
          },
          async prepare(client) {
            await findRemediation(client, id, query, maxPages);
            return { kind: "ready", summary };
          },
        };
      });
    });
}

function registerList(parent: Command, path: string): void {
  parent
    .command("list")
    .description(`List ${parent.name()}`)
    .option("--all", "fetch all pages within --max-pages")
    .option("--max-pages <number>", "maximum pages with --all, from 1 to 100", "100")
    .option("--query <key=value>", "query parameter, repeatable", collect, [])
    .action(async function (
      this: Command,
      options: { all?: boolean; maxPages: string; query: string[] },
    ) {
      await run(this, ({ client }) => {
        const query = parseQueryOptions(options.query);
        const maxPages = parseMaxPages(options.maxPages);
        return options.all
          ? requestAllPages(client, path, query, { maxPages })
          : client.request({ path, query });
      });
    });
}

async function mutate(command: Command, createPlan: () => MutationPlan): Promise<void> {
  await run(command, async ({ globals, client }) => {
    const plan = createPlan();
    if (!globals.apply) {
      return {
        dryRun: true,
        mutation: true,
        requiresApply: true,
        confirmationRequired: !globals.yes,
        summary: plan.summary,
        request: plan.request,
        guidance: "Pass --apply to execute this mutation. Target checks run only at apply time.",
      };
    }
    const prepared = await plan.prepare(client);
    if (prepared.kind === "unchanged")
      return { noChange: true, id: plan.id, reason: "Already active." };
    await confirmWrite(prepared.summary, globals);
    const result = assertSingleTargetBulkResult(await client.request(plan.request), plan.id);
    return {
      accepted: true,
      result,
      guidance: "Vanta accepted the update. No post-write state was read.",
    };
  });
}
