import { Command, Option } from "commander";
import { z } from "zod";

import type { VantaClient } from "../api.ts";
import { globalsFrom, run, runLocal } from "../cli-run.ts";
import { CliError } from "../errors.ts";
import { collect, confirmWrite, parseQueryOptions } from "../io.ts";
import { parseMultipart, type MultipartPart } from "../multipart.ts";
import { parseMaxPages, requestAllPages } from "../pagination.ts";

const identitySchema = z.object({ id: z.string() }).passthrough();
const ownedSchema = identitySchema.extend({ vendorId: z.string() });
const collectionSchema = z
  .object({
    results: z.object({ data: z.array(z.unknown()) }).passthrough(),
  })
  .passthrough();

type ListOptions = { query: string[]; all?: boolean; maxPages: string };
type UploadOptions = { file: string; type: string; title?: string; description?: string };

function vendorPath(vendorId: string): string {
  return `/v1/vendors/${encodeURIComponent(vendorId)}`;
}

function reviewPath(vendorId: string, reviewId: string): string {
  return `${vendorPath(vendorId)}/security-reviews/${encodeURIComponent(reviewId)}`;
}

function assertIdentity(value: unknown, id: string): void {
  const parsed = identitySchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== id) {
    throw new CliError(`Vendor API returned a missing or mismatched resource ID for ${id}.`);
  }
}

function assertOwner(value: unknown, vendorId: string, id?: string): void {
  const parsed = ownedSchema.safeParse(value);
  if (!parsed.success || parsed.data.vendorId !== vendorId) {
    throw new CliError(`Vendor API returned a missing or mismatched vendorId for ${vendorId}.`);
  }
  if (id !== undefined) assertIdentity(parsed.data, id);
}

async function list(
  client: VantaClient,
  path: string,
  options: ListOptions,
  vendorId?: string,
): Promise<unknown> {
  const query = parseQueryOptions(options.query);
  const maxPages = parseMaxPages(options.maxPages);
  const result = options.all
    ? await requestAllPages(client, path, query, { maxPages })
    : await client.request({ path, query });
  const parsed = collectionSchema.safeParse(result);
  if (!parsed.success) throw new CliError(`Invalid vendor collection response for ${path}.`);
  if (vendorId !== undefined) {
    for (const row of parsed.data.results.data) assertOwner(row, vendorId);
  }
  return result;
}

function listOptions(command: Command): Command {
  return command
    .option("--all", "fetch all pages within --max-pages")
    .option("--max-pages <number>", "maximum pages with --all, from 1 to 100", "100")
    .option("--query <key=value>", "query parameter, repeatable", collect, []);
}

function uploadParts(options: UploadOptions): MultipartPart[] {
  if (!options.type.trim()) throw new CliError("--type must be a nonempty document type.");
  return parseMultipart({
    file: [`file=${options.file}`],
    fileType: [],
    form: [
      `type=${options.type}`,
      ...(options.title !== undefined ? [`title=${options.title}`] : []),
      ...(options.description !== undefined ? [`description=${options.description}`] : []),
    ],
  });
}

async function mutate(
  command: Command,
  target: { vendorId: string; reviewId?: string },
  parts: MultipartPart[],
  status?: string,
): Promise<void> {
  const { vendorId, reviewId } = target;
  const path =
    status !== undefined
      ? `${vendorPath(vendorId)}/set-status`
      : `${reviewId === undefined ? vendorPath(vendorId) : reviewPath(vendorId, reviewId)}/documents`;
  const request = { method: "POST", path, parts };
  const summary =
    status !== undefined
      ? `Set vendor ${vendorId} status to ${status}`
      : `Upload document to vendor ${vendorId}${reviewId === undefined ? "" : ` security review ${reviewId}`}`;
  const globals = globalsFrom(command);
  if (!globals.apply) {
    await runLocal(command, () => ({
      dryRun: true,
      mutation: true,
      requiresApply: true,
      confirmationRequired: !globals.yes,
      summary,
      request,
      guidance: "Pass --apply to execute this mutation. Vendor ownership is checked at apply time.",
    }));
    return;
  }
  await run(command, async ({ client }) => {
    const vendor = await client.request({ path: vendorPath(vendorId) });
    assertIdentity(vendor, vendorId);
    if (status !== undefined) {
      const current = identitySchema.extend({ status: z.string() }).safeParse(vendor);
      if (!current.success) throw new CliError("Vendor API returned a missing status.");
      if (current.data.status === status) return { noChange: true, vendorId, status };
    }
    if (reviewId !== undefined) {
      const review = await client.request({ path: reviewPath(vendorId, reviewId) });
      assertOwner(review, vendorId, reviewId);
    }
    await confirmWrite(summary, globals);
    const result = await client.multipart(request);
    if (status !== undefined) {
      assertIdentity(result, vendorId);
      const updated = identitySchema.extend({ status: z.literal(status) }).safeParse(result);
      if (!updated.success) throw new CliError("Vendor API did not return the requested status.");
    }
    return result;
  });
}

function documents(parent: Command, forReview = false): void {
  const command = parent.command("documents").description("Vendor evidence documents");
  const addArguments = (child: Command) => {
    child.argument("<vendorId>");
    if (forReview) child.argument("<reviewId>");
    return child;
  };
  const read = addArguments(command.command("list").description("List vendor evidence documents"));
  listOptions(read).action(async function (this: Command, ...args: unknown[]) {
    const vendorId = z.string().parse(args[0]);
    const reviewId = forReview ? z.string().parse(args[1]) : undefined;
    const options = read.opts<ListOptions>();
    const path = `${reviewId === undefined ? vendorPath(vendorId) : reviewPath(vendorId, reviewId)}/documents`;
    await run(this, ({ client }) => list(client, path, options));
  });
  const upload = addArguments(
    command
      .command("upload")
      .description("Upload vendor evidence after apply-time ownership checks"),
  )
    .requiredOption("--file <path>", "existing evidence file")
    .requiredOption("--type <type>", "nonempty Vanta document type (not a fixed enum)")
    .option("--title <title>", "document title")
    .option("--description <description>", "document description");
  upload.action(async function (this: Command, ...args: unknown[]) {
    const vendorId = z.string().parse(args[0]);
    const reviewId = forReview ? z.string().parse(args[1]) : undefined;
    await mutate(this, { vendorId, reviewId }, uploadParts(upload.opts<UploadOptions>()));
  });
}

export function registerVendorEvidenceCommands(vendors: Command): void {
  documents(vendors);
  vendors
    .command("set-status")
    .description("Set vendor status after reading the vendor; dry-run by default")
    .argument("<vendorId>")
    .addOption(
      new Option("--status <status>", "target vendor status")
        .choices(["MANAGED", "ARCHIVED", "IN_PROCUREMENT"])
        .makeOptionMandatory(),
    )
    .action(async function (this: Command, vendorId: string, options: { status: string }) {
      await mutate(
        this,
        { vendorId },
        [{ kind: "text", name: "status", value: options.status }],
        options.status,
      );
    });
  for (const name of ["assessments", "security-reviews"]) {
    const command = vendors.command(name).description(`Vendor ${name}`);
    listOptions(
      command.command("list").argument("<vendorId>").description(`List vendor ${name}`),
    ).action(async function (this: Command, vendorId: string, options: ListOptions) {
      await run(this, ({ client }) =>
        list(client, `${vendorPath(vendorId)}/${name}`, options, vendorId),
      );
    });
    command
      .command("get")
      .argument("<vendorId>")
      .argument(name === "assessments" ? "<assessmentId>" : "<reviewId>")
      .description(`Get one vendor ${name} item`)
      .action(async function (this: Command, vendorId: string, id: string) {
        await run(this, async ({ client }) => {
          const result = await client.request({
            path: `${vendorPath(vendorId)}/${name}/${encodeURIComponent(id)}`,
          });
          assertOwner(result, vendorId, id);
          return result;
        });
      });
    if (name === "security-reviews") documents(command, true);
  }
}
