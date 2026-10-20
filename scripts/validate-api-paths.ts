#!/usr/bin/env bun
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const ROOT = path.resolve(import.meta.dir, "..");
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const pagination = ["pageSize", "pageCursor"];

type Contract = {
  api: "manage" | "auditor";
  method: string;
  path: string;
  query?: string[];
  body?: { contentType: string; fields?: Record<string, string>; supplied?: string[] };
};
const jsonBody = { contentType: "application/json" };
const ownerBody = { ...jsonBody, fields: { userId: "string" }, supplied: ["userId"] };

// Every curated method/path, including fields built by the CLI. Raw calls and
// arbitrary user-supplied JSON are intentionally outside this contract.
export const CURATED_OPERATIONS: Contract[] = [
  ...[
    ["frameworks", "frameworkId"],
    ["issues", "issueId"],
    ["policies", "policyId"],
    ["tests", "testId"],
    ["people", "personId"],
    ["controls", "controlId"],
    ["documents", "documentId"],
    ["vendors", "vendorId"],
    ["integrations", "integrationId"],
    ["vulnerabilities", "vulnerabilityId"],
  ].flatMap(([resource, id]): Contract[] => [
    {
      api: "manage",
      method: "get",
      path: `/${resource}`,
      query: [
        ...pagination,
        ...(resource === "tests" ? ["statusFilter", "frameworkFilter", "isInRollout"] : []),
        ...(resource === "documents" ? ["frameworkMatchesAny", "statusMatchesAny"] : []),
      ],
    },
    { api: "manage", method: "get", path: `/${resource}/{${id}}` },
  ]),
  ...[
    "/vulnerabilities/deactivate",
    "/vulnerabilities/reactivate",
    "/vulnerability-remediations/acknowledge-sla-miss",
  ].map((path): Contract => ({
    api: "manage",
    method: "post",
    path,
    body: { ...jsonBody, fields: { updates: "array" }, supplied: ["updates"] },
  })),
  {
    api: "manage",
    method: "get",
    path: "/vulnerable-assets",
    query: [...pagination, "q", "integrationId", "assetType", "assetExternalAccountId"],
  },
  { api: "manage", method: "get", path: "/vulnerable-assets/{vulnerableAssetId}" },
  {
    api: "manage",
    method: "get",
    path: "/vulnerability-remediations",
    query: [
      ...pagination,
      "integrationId",
      "severity",
      "isRemediatedOnTime",
      "remediatedAfterDate",
      "remediatedBeforeDate",
    ],
  },
  {
    api: "manage",
    method: "patch",
    path: "/people/{personId}",
    body: { ...jsonBody, fields: { name: "object", employment: "object" } },
  },
  {
    api: "manage",
    method: "post",
    path: "/people/{personId}/set-leave",
    body: {
      ...jsonBody,
      fields: { startDate: "string", endDate: "string" },
      supplied: ["startDate", "endDate"],
    },
  },
  { api: "manage", method: "post", path: "/people/{personId}/clear-leave" },
  {
    api: "manage",
    method: "post",
    path: "/people/offboard",
    body: { ...jsonBody, fields: { updates: "array" }, supplied: ["updates"] },
  },
  { api: "manage", method: "post", path: "/controls/{controlId}/set-owner", body: ownerBody },
  { api: "manage", method: "patch", path: "/controls/{controlId}", body: jsonBody },
  { api: "manage", method: "delete", path: "/controls/{controlId}" },
  { api: "manage", method: "post", path: "/documents", body: jsonBody },
  { api: "manage", method: "delete", path: "/documents/{documentId}" },
  { api: "manage", method: "post", path: "/documents/{documentId}/set-owner", body: ownerBody },
  {
    api: "manage",
    method: "post",
    path: "/documents/{documentId}/uploads",
    body: {
      contentType: "multipart/form-data",
      fields: { file: "string", description: "string", effectiveAtDate: "string" },
      supplied: ["file"],
    },
  },
  { api: "manage", method: "get", path: "/documents/{documentId}/uploads/{uploadedFileId}/media" },
  { api: "manage", method: "get", path: "/documents/{documentId}/links", query: pagination },
  ...[
    "/frameworks/{frameworkId}/controls",
    "/controls/{controlId}/tests",
    "/controls/{controlId}/documents",
    "/documents/{documentId}/controls",
    "/documents/{documentId}/uploads",
  ].map((path): Contract => ({ api: "manage", method: "get", path, query: pagination })),
  { api: "manage", method: "get", path: "/integrations/{integrationId}/resource-kinds" },
  {
    api: "manage",
    method: "get",
    path: "/integrations/{integrationId}/resource-kinds/{resourceKind}",
    query: ["connectionId"],
  },
  { api: "manage", method: "post", path: "/documents/{documentId}/submit" },
  { api: "manage", method: "post", path: "/documents/{documentId}/links", body: jsonBody },
  { api: "manage", method: "delete", path: "/documents/{documentId}/links/{linkId}" },
  { api: "manage", method: "post", path: "/vendors", body: jsonBody },
  { api: "manage", method: "patch", path: "/vendors/{vendorId}", body: jsonBody },
  ...[
    "/vendors/{vendorId}/documents",
    "/vendors/{vendorId}/assessments",
    "/vendors/{vendorId}/security-reviews",
    "/vendors/{vendorId}/security-reviews/{securityReviewId}/documents",
  ].map((path): Contract => ({ api: "manage", method: "get", path, query: pagination })),
  ...[
    "/vendors/{vendorId}/assessments/{assessmentId}",
    "/vendors/{vendorId}/security-reviews/{securityReviewId}",
  ].map((path): Contract => ({ api: "manage", method: "get", path })),
  ...[
    "/vendors/{vendorId}/documents",
    "/vendors/{vendorId}/security-reviews/{securityReviewId}/documents",
  ].map((path): Contract => ({
    api: "manage",
    method: "post",
    path,
    body: {
      contentType: "multipart/form-data",
      fields: { file: "string", type: "string", title: "string", description: "string" },
      supplied: ["file", "type"],
    },
  })),
  {
    api: "manage",
    method: "post",
    path: "/vendors/{vendorId}/set-status",
    body: {
      contentType: "multipart/form-data",
      fields: { status: "string" },
      supplied: ["status"],
    },
  },
  {
    api: "manage",
    method: "get",
    path: "/integrations/{integrationId}/resource-kinds/{resourceKind}/resources",
    query: [...pagination, "connectionId", "isInScope"],
  },
  {
    api: "manage",
    method: "patch",
    path: "/integrations/{integrationId}/resource-kinds/{resourceKind}/resources",
    body: { ...jsonBody, fields: { updates: "array" }, supplied: ["updates"] },
  },
  {
    api: "manage",
    method: "get",
    path: "/tests/{testId}/entities",
    query: [...pagination, "entityStatus"],
  },
  {
    api: "manage",
    method: "post",
    path: "/tests/{testId}/entities/{entityId}/deactivate",
    body: {
      ...jsonBody,
      fields: { deactivateReason: "string", deactivateUntilDate: "string" },
      supplied: ["deactivateReason"],
    },
  },
  { api: "manage", method: "post", path: "/tests/{testId}/entities/{entityId}/reactivate" },
  ...[
    { path: "/audits", query: [...pagination, "changedSinceDate", "isActiveAudit"] },
    { path: "/audits/{auditId}" },
    { path: "/audits/{auditId}/controls", query: [...pagination, "externalIdMatchesAny"] },
    { path: "/audits/{auditId}/evidence", query: [...pagination, "changedSinceDate"] },
    { path: "/audits/{auditId}/evidence/{auditEvidenceId}" },
    { path: "/audits/{auditId}/evidence/{auditEvidenceId}/urls", query: pagination },
    {
      path: "/audits/{auditId}/information-requests",
      query: [...pagination, "changedSinceDate", "segmentIdsMatchesAny"],
    },
    { path: "/audits/{auditId}/information-requests/{requestId}" },
  ].map((entry): Contract => ({ api: "auditor", method: "get", ...entry })),
  {
    api: "auditor",
    method: "get",
    path: "/audits/{auditId}/assets/code-changes",
    query: [...pagination, "search", "sourcesMatchesAny", "closedAfterDate", "closedBeforeDate"],
  },
];

// These contracts describe fixture inputs, not curated command coverage.
export const RAW_TRANSPORT_FIXTURES: Contract[] = (
  [
    ["/contracts", ["file"]],
    ["/customer-trust/questionnaires/file", ["file", "displayName"]],
    ["/knowledge-base/resources/documents", ["file", "title"]],
    ["/knowledge-base/resources/documents/{id}/upload", ["file"]],
    ["/trust-centers/{slugId}/compliance-frameworks/{frameworkId}/badge", ["file"]],
    ["/trust-centers/{slugId}/favicon", ["favicon"]],
    ["/trust-centers/{slugId}/resources", ["file", "title", "isPublic"]],
    ["/vendors/{vendorId}/documents", ["file", "type"]],
    ["/vendors/{vendorId}/security-reviews/{securityReviewId}/documents", ["file", "type"]],
    ["/vendors/{vendorId}/set-status", ["status"]],
  ] satisfies [string, string[]][]
).map(([path, fields]): Contract => {
  return {
    api: "manage",
    method: "post",
    path,
    body: {
      contentType: "multipart/form-data",
      supplied: fields,
      fields: Object.fromEntries(fields.map((name) => [name, "string"])),
    },
  };
});
RAW_TRANSPORT_FIXTURES.push({
  api: "manage",
  method: "get",
  path: "/trust-centers/{slugId}/resources/{resourceId}/media",
});

const objectSchema = z.record(z.string(), z.unknown());
const specSchema = z.object({ paths: z.record(z.string(), objectSchema) }).passthrough();
type Spec = z.infer<typeof specSchema>;

function resolveObject(spec: Spec, value: unknown): Record<string, unknown> {
  let object = objectSchema.parse(value);
  const seen = new Set<string>();
  while (typeof object.$ref === "string") {
    const ref = object.$ref;
    if (!ref.startsWith("#/") || seen.has(ref))
      throw new Error(`Unsupported schema reference: ${ref}`);
    seen.add(ref);
    let target: unknown = spec;
    for (const key of ref.slice(2).split("/")) {
      target = objectSchema.parse(target)[key.replace(/~1/g, "/").replace(/~0/g, "~")];
    }
    object = objectSchema.parse(target);
  }
  return object;
}

export function validateContract(spec: Spec, contract: Contract): void {
  const item = spec.paths[contract.path];
  const operation = resolveObject(spec, item?.[contract.method]);
  const parameters = z.array(z.unknown()).parse(operation.parameters ?? []);
  const availableQuery = new Set(
    parameters
      .map((value) => resolveObject(spec, value))
      .filter((value) => value.in === "query")
      .map((value) => value.name),
  );
  for (const query of contract.query ?? []) {
    if (!availableQuery.has(query)) throw new Error(`Missing query parameter: ${query}`);
  }
  if (!contract.body) return;
  const requestBody = resolveObject(spec, operation.requestBody);
  const content = objectSchema.parse(requestBody.content);
  const media = objectSchema.parse(content[contract.body.contentType]);
  const body = resolveObject(spec, media.schema);
  if (!contract.body.fields) return;
  const properties = objectSchema.parse(body.properties);
  for (const [name, type] of Object.entries(contract.body.fields)) {
    if (resolveObject(spec, properties[name]).type !== type)
      throw new Error(`Missing or changed body field: ${name} (${type})`);
  }
  for (const required of z.array(z.string()).parse(body.required ?? [])) {
    if (!contract.body.supplied?.includes(required))
      throw new Error(`CLI does not supply required body field: ${required}`);
  }
}

async function loadSpec(api: Contract["api"], refresh: boolean): Promise<Spec> {
  const explicit = (
    api === "manage" ? process.env.SCHEMA_PATH : process.env.AUDITOR_SCHEMA_PATH
  )?.trim();
  if (explicit) return specSchema.parse(JSON.parse(await readFile(explicit, "utf8")));
  const cache = path.join(ROOT, `.cache/vanta-${api}-openapi.json`);
  if (!refresh) {
    try {
      if (Date.now() - (await stat(cache)).mtimeMs < CACHE_MAX_AGE_MS) {
        return specSchema.parse(JSON.parse(await readFile(cache, "utf8")));
      }
    } catch {
      // Missing, expired, or malformed cache: fetch a fresh published schema.
    }
  }
  const url =
    api === "manage"
      ? (process.env.VANTA_OPENAPI_URL ?? "https://developer.vanta.com/reference/manage-vanta.json")
      : (process.env.VANTA_AUDITOR_OPENAPI_URL ??
        "https://developer.vanta.com/reference/auditor-api.json");
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Failed to download ${api} OpenAPI: HTTP ${response.status}`);
  const text = await response.text();
  const spec = specSchema.parse(JSON.parse(text));
  await mkdir(path.dirname(cache), { recursive: true });
  await writeFile(cache, text, "utf8");
  return spec;
}

export function coverageReport(spec: Spec, api: Contract["api"]) {
  const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) =>
        ["get", "post", "put", "patch", "delete", "head", "options", "trace"].includes(method),
      )
      .map(([method, value]) => {
        const operation = resolveObject(spec, value);
        const curated = CURATED_OPERATIONS.some(
          (entry) => entry.api === api && entry.path === path && entry.method === method,
        );
        const content = operation.requestBody
          ? objectSchema.parse(resolveObject(spec, operation.requestBody).content)
          : {};
        const multipart = "multipart/form-data" in content;
        const needsUnsupportedBody =
          Object.keys(content).length > 0 &&
          !("application/json" in content) &&
          !(multipart && ["post", "put", "patch"].includes(method));
        const responses = objectSchema.parse(operation.responses ?? {});
        const binaryResponse = Object.entries(responses).some(([status, response]) => {
          if (!status.startsWith("2")) return false;
          const media = objectSchema.parse(resolveObject(spec, response).content ?? {});
          return Object.keys(media).some(
            (type) => !type.includes("json") && !type.startsWith("text/"),
          );
        });
        const coverage = curated
          ? "curated"
          : api === "auditor"
            ? method === "get" && Object.keys(content).length === 0 && !binaryResponse
              ? "raw"
              : "unsupported-api"
            : needsUnsupportedBody || (binaryResponse && method !== "get")
              ? "unsupported-transport"
              : "raw";
        return {
          method: method.toUpperCase(),
          path,
          coverage,
          ...(multipart ? { requestTransport: "multipart" } : {}),
          ...(binaryResponse ? { responseTransport: "file" } : {}),
        };
      }),
  );
  return {
    api,
    total: operations.length,
    counts: Object.fromEntries(
      ["curated", "raw", "unsupported-api", "unsupported-transport"].map((category) => [
        category,
        operations.filter((op) => op.coverage === category).length,
      ]),
    ),
    operations,
  };
}

async function main(): Promise<void> {
  const refresh = process.argv.includes("--refresh");
  const [manage, auditor] = await Promise.all([
    loadSpec("manage", refresh),
    loadSpec("auditor", refresh),
  ]);
  if (process.argv.includes("--coverage")) {
    console.log(
      JSON.stringify(
        { reports: [coverageReport(manage, "manage"), coverageReport(auditor, "auditor")] },
        null,
        2,
      ),
    );
    return;
  }
  let failures = 0;
  for (const contract of [...CURATED_OPERATIONS, ...RAW_TRANSPORT_FIXTURES]) {
    const label = `${contract.api} ${contract.method.toUpperCase()} ${contract.path}`;
    try {
      validateContract(contract.api === "manage" ? manage : auditor, contract);
      console.log(`ok  ${label}`);
    } catch (error) {
      failures++;
      console.error(`invalid  ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(
    `\nChecked ${CURATED_OPERATIONS.length} curated operations and ${RAW_TRANSPORT_FIXTURES.length} raw transport fixtures; ${failures} invalid.`,
  );
  if (failures) process.exitCode = 1;
}

if (import.meta.main) await main();
