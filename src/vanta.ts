#!/usr/bin/env bun
import { Command, CommanderError } from "commander";

import { version } from "../package.json";

import { VantaClient } from "./api.ts";
import { reportError, run } from "./cli-run.ts";
import { registerAuthCommands } from "./commands/auth.ts";
import { registerAuditCommands } from "./commands/audits.ts";
import { registerDashboardCommands } from "./commands/dashboard.ts";
import { registerDoctorCommand } from "./commands/doctor.ts";
import { registerRawCommand } from "./commands/raw.ts";
import { registerVulnerabilityCommands } from "./commands/vulnerabilities.ts";

import { CliError } from "./errors.ts";
import {
  executeIntegrationResourceUpdate,
  integrationResourcesPath,
  parseBooleanFlag,
  resourceKindPath,
  resourceKindsPath,
  type ResourceMutation,
  type ResourceSelection,
} from "./integration-resources.ts";
import { collect, confirmWrite, parseBodyInput, parseQueryOptions } from "./io.ts";
import { parseMaxPages, requestAllPages } from "./pagination.ts";
import {
  deactivateEntityBody,
  findTestEntity,
  parseEntityPageSize,
  parseEntityStatus,
  testEntityActionPath,
  testEntitiesPath,
} from "./test-entities.ts";

export type BodyOptions = {
  body?: string;
  bodyFile?: string;
};

export { exitCodeForError } from "./cli-run.ts";
export { formatTokenOutput } from "./commands/auth.ts";
export { parseDashboardStatuses, parseDashboardFormat } from "./commands/dashboard.ts";

const program = new Command();
let parserErrorOutput = "";

program
  .name("vanta")
  .version(version)
  .exitOverride()
  .configureOutput({
    writeErr: (text) => {
      parserErrorOutput += text;
    },
  })
  .description("Vanta Manage API CLI for agents and humans.")
  .option("--json", "print JSON output")
  .option("--apply", "execute mutating commands; otherwise mutations are dry-run")
  .option("--yes", "skip confirmation prompts for mutating commands after --apply")
  .option("--debug", "print stack traces on errors")
  .option(
    "--timeout-ms <milliseconds>",
    "timeout per HTTP request, from 1 to 600000 (default: 30000)",
  )
  .option(
    "--config <path>",
    "local config path (default: ~/.config/vanta-cli/config.json or ~/.vanta-cli.json)",
  )
  .option("--profile <name>", "use a named credential profile under ~/.config/vanta-cli/profiles");

registerAuthCommands(program);

const frameworks = resource(program, "frameworks", v1("/frameworks"), "frameworkId");
const tests = resource(program, "tests", v1("/tests"), "testId");
resource(program, "personnel", v1("/people"), "personId");
const vulnerabilities = resource(
  program,
  "vulnerabilities",
  v1("/vulnerabilities"),
  "vulnerabilityId",
);
registerVulnerabilityCommands(vulnerabilities);

resource(program, "issues", v1("/issues"), "issueId");
resource(program, "policies", v1("/policies"), "policyId");
relatedCollection(frameworks, "controls", "frameworkId", "/v1/frameworks");

const testEntities = tests.command("entities").description("Test entity commands");
testEntities
  .command("list")
  .description("List failing or deactivated entities for a test")
  .argument("<testId>")
  .option("--status <status>", "failing or deactivated", "failing")
  .option("--page-size <number>", "results per page, from 1 to 100")
  .option("--page-cursor <cursor>", "pagination cursor")
  .option("--all", "fetch all pages within --max-pages")
  .option("--max-pages <number>", "maximum pages with --all, from 1 to 100", "100")
  .action(async function (
    this: Command,
    testId: string,
    options: {
      status: string;
      pageSize?: string;
      pageCursor?: string;
      all?: boolean;
      maxPages: string;
    },
  ) {
    await run(this, ({ client }) => {
      const parsed = {
        entityStatus: parseEntityStatus(options.status),
        pageSize: parseEntityPageSize(options.pageSize),
      };
      const maxPages = parseMaxPages(options.maxPages);
      const path = testEntitiesPath(testId);
      const query = {
        entityStatus: parsed.entityStatus,
        pageSize: parsed.pageSize?.toString(),
        pageCursor: options.pageCursor,
      };
      return options.all
        ? requestAllPages(client, path, query, { maxPages })
        : client.request({ path, query });
    });
  });
testEntities
  .command("deactivate")
  .description("Deactivate a failing test entity with a required reason")
  .argument("<testId>")
  .argument("<entityId>")
  .requiredOption("--reason <reason>", "reason for deactivation")
  .option("--until <date-time>", "RFC 3339 expiry; omit for indefinite deactivation")
  .action(async function (
    this: Command,
    testId: string,
    entityId: string,
    options: { reason: string; until?: string },
  ) {
    await mutate(this, () => {
      const body = deactivateEntityBody(options.reason, options.until);
      const request = {
        method: "POST",
        path: testEntityActionPath(testId, entityId, "deactivate"),
        body,
      };
      return {
        summary: deactivateEntitySummary(
          testId,
          entityId,
          body.deactivateReason,
          body.deactivateUntilDate,
        ),
        request,
        operation: async (client: VantaClient) => {
          await client.request(request);
          return acceptedTestEntityAction("deactivate", testId, entityId);
        },
        prepare: async (client: VantaClient) => {
          const entity = await findTestEntity(client, testId, entityId, "FAILING");
          return deactivateEntitySummary(
            testId,
            entityId,
            body.deactivateReason,
            body.deactivateUntilDate,
            entity,
          );
        },
      };
    });
  });
testEntities
  .command("reactivate")
  .description("Reactivate a deactivated test entity")
  .argument("<testId>")
  .argument("<entityId>")
  .action(async function (this: Command, testId: string, entityId: string) {
    await mutate(this, () => {
      const request = {
        method: "POST",
        path: testEntityActionPath(testId, entityId, "reactivate"),
      };
      return {
        summary: `Reactivate test entity ${entityId} for test ${testId}`,
        request,
        operation: async (client: VantaClient) => {
          await client.request(request);
          return acceptedTestEntityAction("reactivate", testId, entityId);
        },
        prepare: async (client: VantaClient) => {
          const entity = await findTestEntity(client, testId, entityId, "DEACTIVATED");
          return `Reactivate ${entity.displayName} (${entity.id}) for test ${testId}`;
        },
      };
    });
  });

const controlsPath = v1("/controls");
const controls = resource(program, "controls", controlsPath, "controlId");
relatedCollection(controls, "tests", "controlId", controlsPath);
relatedCollection(controls, "documents", "controlId", controlsPath);
controls
  .command("set-owner")
  .description("Set a control owner")
  .argument("<controlId>")
  .requiredOption("--owner-id <ownerId>", "Vanta owner/person ID")
  .action(async function (this: Command, controlId: string, options: { ownerId: string }) {
    const request = {
      method: "POST",
      path: `${controlsPath}/${controlId}/set-owner`,
      body: { userId: options.ownerId },
    };
    await mutate(this, {
      summary: `Set owner for control ${controlId} to ${options.ownerId}`,
      request,
      operation: (client) => client.request(request),
    });
  });
controls
  .command("update")
  .description("Patch a control with a JSON body")
  .argument("<controlId>")
  .option("--body <json>", "JSON request body")
  .option("--body-file <path>", "read JSON request body from file")
  .action(async function (this: Command, controlId: string, options: BodyOptions) {
    const body = parseRequiredBodyInput(options);
    const request = { method: "PATCH", path: `${controlsPath}/${controlId}`, body };
    await mutate(this, {
      summary: `Update control ${controlId}`,
      request,
      operation: (client) => client.request(request),
    });
  });
controls
  .command("deactivate")
  .description("Deactivate a control")
  .argument("<controlId>")
  .action(async function (this: Command, controlId: string) {
    const request = { method: "DELETE", path: `${controlsPath}/${controlId}` };
    await mutate(this, {
      summary: `Deactivate control ${controlId}`,
      request,
      operation: (client) => client.request(request),
    });
  });

const documentsPath = v1("/documents");
const documents = resource(program, "documents", documentsPath, "documentId");
relatedCollection(documents, "controls", "documentId", documentsPath);
relatedCollection(documents, "uploads", "documentId", documentsPath);
documents
  .command("submit")
  .description("Submit document evidence for review")
  .argument("<documentId>")
  .action(async function (this: Command, documentId: string) {
    const request = {
      method: "POST",
      path: `${documentsPath}/${encodeURIComponent(documentId)}/submit`,
    };
    await mutate(this, {
      summary: `Submit evidence for document ${documentId}`,
      request,
      operation: (client) => client.request(request),
    });
  });
documents
  .command("add-link")
  .description("Add a document link with a JSON body")
  .argument("<documentId>")
  .option("--body <json>", "JSON request body")
  .option("--body-file <path>", "read JSON request body from file")
  .action(async function (this: Command, documentId: string, options: BodyOptions) {
    const request = {
      method: "POST",
      path: `${documentsPath}/${encodeURIComponent(documentId)}/links`,
      body: parseRequiredBodyInput(options),
    };
    await mutate(this, {
      summary: `Add link to document ${documentId}`,
      request,
      operation: (client) => client.request(request),
    });
  });
documents
  .command("remove-link")
  .description("Remove a document link")
  .argument("<documentId>")
  .argument("<linkId>")
  .action(async function (this: Command, documentId: string, linkId: string) {
    const request = {
      method: "DELETE",
      path: `${documentsPath}/${encodeURIComponent(documentId)}/links/${encodeURIComponent(linkId)}`,
    };
    await mutate(this, {
      summary: `Remove link ${linkId} from document ${documentId}`,
      request,
      operation: (client) => client.request(request),
    });
  });
documents
  .command("create")
  .description("Create a document with a JSON body")
  .option("--body <json>", "JSON request body")
  .option("--body-file <path>", "read JSON request body from file")
  .action(async function (this: Command, options: BodyOptions) {
    const body = parseRequiredBodyInput(options);
    const request = { method: "POST", path: documentsPath, body };
    await mutate(this, {
      summary: "Create document",
      request,
      operation: (client) => client.request(request),
    });
  });
documents
  .command("delete")
  .description("Delete a document")
  .argument("<documentId>")
  .action(async function (this: Command, documentId: string) {
    const request = { method: "DELETE", path: `${documentsPath}/${documentId}` };
    await mutate(this, {
      summary: `Delete document ${documentId}`,
      request,
      operation: (client) => client.request(request),
    });
  });
documents
  .command("upload")
  .description("Upload a file to a document")
  .argument("<documentId>")
  .requiredOption("--file <path>", "file to upload")
  .option("--description <text>", "description of uploaded evidence")
  .option("--effective-at-date <date>", "date the evidence becomes effective")
  .action(async function (
    this: Command,
    documentId: string,
    options: { file: string; description?: string; effectiveAtDate?: string },
  ) {
    const request = {
      method: "POST",
      path: `${documentsPath}/${encodeURIComponent(documentId)}/uploads`,
      uploadFile: options.file,
      fields: { description: options.description, effectiveAtDate: options.effectiveAtDate },
    };
    await mutate(this, {
      summary: `Upload ${options.file} to document ${documentId}`,
      request,
      operation: (client) => client.upload(request.path, options.file, request.fields),
    });
  });
documents
  .command("download")
  .description("Download an uploaded document file")
  .argument("<documentId>")
  .argument("<uploadedFileId>")
  .option("--output <path>", "write bytes to a file")
  .option("--force", "overwrite an existing --output file")
  .action(async function (
    this: Command,
    documentId: string,
    uploadedFileId: string,
    options: { output?: string; force?: boolean },
  ) {
    await run(this, ({ client, globals }) => {
      if (options.force && !options.output) throw new CliError("--force requires --output.");
      if (globals.json && !options.output) {
        throw new CliError("Use --output <path> for downloads with --json.");
      }
      return client.download(
        `${documentsPath}/${encodeURIComponent(documentId)}/uploads/${encodeURIComponent(uploadedFileId)}/media`,
        options.output,
        { force: options.force },
      );
    });
  });
documents
  .command("set-owner")
  .description("Set a document owner")
  .argument("<documentId>")
  .requiredOption("--owner-id <ownerId>", "Vanta owner/person ID")
  .action(async function (this: Command, documentId: string, options: { ownerId: string }) {
    const request = {
      method: "POST",
      path: `${documentsPath}/${documentId}/set-owner`,
      body: { userId: options.ownerId },
    };
    await mutate(this, {
      summary: `Set owner for document ${documentId} to ${options.ownerId}`,
      request,
      operation: (client) => client.request(request),
    });
  });
documents
  .command("links")
  .description("List document links")
  .argument("<documentId>")
  .option("--all", "fetch all pages within --max-pages")
  .option("--max-pages <number>", "maximum pages with --all, from 1 to 100", "100")
  .option("--query <key=value>", "query parameter, repeatable", collect, [])
  .action(async function (
    this: Command,
    documentId: string,
    options: { all?: boolean; maxPages: string; query: string[] },
  ) {
    await run(this, ({ client }) => {
      const path = `${documentsPath}/${encodeURIComponent(documentId)}/links`;
      const maxPages = parseMaxPages(options.maxPages);
      const query = parseQueryOptions(options.query);
      return options.all
        ? requestAllPages(client, path, query, { maxPages })
        : client.request({ path, query });
    });
  });

const vendorsPath = v1("/vendors");
const vendors = resource(program, "vendors", vendorsPath, "vendorId");
vendors
  .command("create")
  .description("Create a vendor with a JSON body")
  .option("--body <json>", "JSON request body")
  .option("--body-file <path>", "read JSON request body from file")
  .action(async function (this: Command, options: BodyOptions) {
    const body = parseRequiredBodyInput(options);
    const request = { method: "POST", path: vendorsPath, body };
    await mutate(this, {
      summary: "Create vendor",
      request,
      operation: (client) => client.request(request),
    });
  });
vendors
  .command("update")
  .description("Patch a vendor with a JSON body")
  .argument("<vendorId>")
  .option("--body <json>", "JSON request body")
  .option("--body-file <path>", "read JSON request body from file")
  .action(async function (this: Command, vendorId: string, options: BodyOptions) {
    const body = parseRequiredBodyInput(options);
    const request = { method: "PATCH", path: `${vendorsPath}/${vendorId}`, body };
    await mutate(this, {
      summary: `Update vendor ${vendorId}`,
      request,
      operation: (client) => client.request(request),
    });
  });

const integrationsPath = v1("/integrations");
const integrations = resource(program, "integrations", integrationsPath, "integrationId");
integrations
  .command("resource-kinds")
  .description("List available resource kinds for an integration")
  .argument("<integrationId>")
  .action(async function (this: Command, integrationId: string) {
    await run(this, ({ client }) =>
      client.request({
        path: resourceKindsPath(integrationId),
      }),
    );
  });
integrations
  .command("resource-kind")
  .description("Show one resource kind, including scope and owner counts")
  .argument("<integrationId>")
  .argument("<resourceKind>")
  .option("--connection-id <connectionId>", "limit counts to one Vanta connection")
  .action(async function (
    this: Command,
    integrationId: string,
    resourceKind: string,
    options: { connectionId?: string },
  ) {
    await run(this, ({ client }) =>
      client.request({
        path: resourceKindPath(integrationId, resourceKind),
        query: { connectionId: options.connectionId },
      }),
    );
  });
integrations
  .command("resources")
  .description("List resources for an integration resource kind")
  .argument("<integrationId>")
  .argument("<resourceKind>")
  .option("--all", "fetch all pages within --max-pages")
  .option("--max-pages <number>", "maximum pages with --all, from 1 to 100", "100")
  .option("--query <key=value>", "query parameter, repeatable", collect, [])
  .action(async function (
    this: Command,
    integrationId: string,
    resourceKind: string,
    options: { query: string[]; all?: boolean; maxPages: string },
  ) {
    await run(this, ({ client }) => {
      const path = integrationResourcesPath(integrationId, resourceKind);
      const maxPages = parseMaxPages(options.maxPages);
      const query = parseQueryOptions(options.query);
      return options.all
        ? requestAllPages(client, path, query, { maxPages })
        : client.request({ path, query });
    });
  });
integrations
  .command("update-resources")
  .description("Set inScope, owner, and description on integration resources")
  .argument("<integrationId>")
  .argument("<resourceKind>")
  .option("--id <resourceId>", "resource id to update, repeatable", collect, [])
  .option("--region <region>", "exact region match, for example ap-south-1")
  .option("--account <account>", "exact account, account name, account id, or AWS account number")
  .option("--connection-id <connectionId>", "Vanta connection id")
  .option("--display-name <pattern>", "regular expression matched against displayName")
  .option("--in-scope <true|false>", "keep resources whose current inScope matches")
  .option("--set-in-scope <true|false>", "set inScope")
  .option("--owner-id <ownerId>", "set the Vanta owner id")
  .option("--description <description>", "set the Vanta description")
  .option("--max-pages <number>", "maximum list pages when filters are used, from 1 to 100", "100")
  .action(async function (
    this: Command,
    integrationId: string,
    resourceKind: string,
    options: {
      id: string[];
      region?: string;
      account?: string;
      connectionId?: string;
      displayName?: string;
      inScope?: string;
      setInScope?: string;
      ownerId?: string;
      description?: string;
      maxPages: string;
    },
  ) {
    const selection: ResourceSelection = {
      ids: options.id,
      region: options.region,
      account: options.account,
      connectionId: options.connectionId,
      displayNamePattern: options.displayName,
      inScope: parseBooleanFlag("--in-scope", options.inScope),
    };
    const mutation: ResourceMutation = {
      inScope: parseBooleanFlag("--set-in-scope", options.setInScope),
      ownerId: options.ownerId,
      description: options.description,
    };
    const maxPages = parseMaxPages(options.maxPages);
    await run(this, ({ client, globals }) =>
      executeIntegrationResourceUpdate(client, {
        integrationId,
        resourceKind,
        selection,
        mutation,
        maxPages,
        apply: globals.apply === true,
        confirm: (summary) => confirmWrite(summary, globals),
      }),
    );
  });

registerDashboardCommands(program);

registerAuditCommands(program);

registerDoctorCommand(program);

registerRawCommand(program);

function relatedCollection(parent: Command, name: string, idName: string, basePath: string): void {
  parent
    .command(name)
    .description(`List ${name} for a ${idName}`)
    .argument(`<${idName}>`)
    .option("--all", "fetch all pages within --max-pages")
    .option("--max-pages <number>", "maximum pages with --all, from 1 to 100", "100")
    .option("--query <key=value>", "query parameter, repeatable", collect, [])
    .action(async function (
      this: Command,
      id: string,
      options: { all?: boolean; maxPages: string; query: string[] },
    ) {
      await run(this, ({ client }) => {
        const path = `${basePath}/${encodeURIComponent(id)}/${name}`;
        const query = parseQueryOptions(options.query);
        const maxPages = parseMaxPages(options.maxPages);
        return options.all
          ? requestAllPages(client, path, query, { maxPages })
          : client.request({ path, query });
      });
    });
}

function resource(program: Command, name: string, basePath: string, idName: string): Command {
  const command = program.command(name).description(`${name} commands`);
  command
    .command("list")
    .description(`List ${name}`)
    .option("--all", "fetch all pages within --max-pages")
    .option("--max-pages <number>", "maximum pages with --all, from 1 to 100", "100")
    .option("--query <key=value>", "query parameter, repeatable", collect, [])
    .action(async function (
      this: Command,
      options: { query: string[]; all?: boolean; maxPages: string },
    ) {
      await run(this, ({ client }) => {
        const maxPages = parseMaxPages(options.maxPages);
        const query = parseQueryOptions(options.query);
        return options.all
          ? requestAllPages(client, basePath, query, { maxPages })
          : client.request({ path: basePath, query });
      });
    });
  command
    .command("get")
    .description(`Get one ${name} item`)
    .argument(`<${idName}>`)
    .action(async function (this: Command, id: string) {
      await run(this, ({ client }) => client.request({ path: `${basePath}/${id}` }));
    });
  return command;
}

type MutationRequest = {
  method: string;
  path: string;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  uploadFile?: string;
  fields?: Record<string, string | undefined>;
};

type MutationPlan = {
  summary: string;
  request: MutationRequest;
  operation: (client: VantaClient) => Promise<unknown>;
  prepare?: (client: VantaClient) => Promise<string>;
};

async function mutate(
  command: Command,
  planOrFactory: MutationPlan | (() => MutationPlan),
): Promise<void> {
  await run(command, async ({ globals, client }) => {
    const plan = typeof planOrFactory === "function" ? planOrFactory() : planOrFactory;
    if (!globals.apply) {
      return {
        dryRun: true,
        mutation: true,
        requiresApply: true,
        confirmationRequired: !globals.yes,
        summary: plan.summary,
        request: plan.request,
        guidance: "Pass --apply to execute this mutation.",
      };
    }
    await confirmWrite(plan.prepare ? await plan.prepare(client) : plan.summary, globals);
    return plan.operation(client);
  });
}

function deactivateEntitySummary(
  testId: string,
  entityId: string,
  reason: string,
  until?: string,
  entity?: { displayName: string },
): string {
  const target = entity ? `${entity.displayName} (${entityId})` : entityId;
  const duration = until ? `until ${until}` : "indefinitely";
  return `Deactivate test entity ${target} for test ${testId} ${duration}. Reason: ${reason}`;
}

function acceptedTestEntityAction(
  action: "deactivate" | "reactivate",
  testId: string,
  entityId: string,
) {
  return {
    accepted: true,
    pending: true,
    action,
    testId,
    entityId,
    guidance: "Vanta may not reflect this change until the next test run.",
  };
}

export function v1(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return normalized.startsWith("/v1/") ? normalized : `/v1${normalized}`;
}

export function parseRequiredBodyInput(options: BodyOptions): unknown {
  const body = parseBodyInput(options);
  if (body === undefined) throw new CliError("Provide --body or --body-file.");
  return body;
}

if (import.meta.main) {
  try {
    await program.parseAsync();
  } catch (error) {
    if (!(error instanceof CommanderError && error.exitCode === 0)) {
      const args = process.argv.slice(2);
      const optionArgs = args.slice(0, args.indexOf("--") < 0 ? args.length : args.indexOf("--"));
      if (
        error instanceof CommanderError &&
        error.code === "commander.help" &&
        !optionArgs.includes("--json")
      ) {
        process.stderr.write(parserErrorOutput);
        process.exitCode = error.exitCode;
      } else {
        reportError(
          error instanceof CommanderError ? new CliError(error.message, error.exitCode) : error,
          {
            ...program.opts(),
            json: optionArgs.includes("--json"),
            debug: optionArgs.includes("--debug"),
          },
        );
      }
    }
  }
}
