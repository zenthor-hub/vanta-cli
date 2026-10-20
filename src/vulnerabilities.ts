import { z } from "zod";

import type { RequestOptions, VantaClient } from "./api.ts";
import { CliError } from "./errors.ts";
import { PaginationGuard } from "./pagination.ts";

const dateTimeSchema = z.iso.datetime({ offset: true });
const RFC3339_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const vulnerabilityStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  deactivateMetadata: z
    .object({
      isVulnDeactivatedIndefinitely: z.boolean(),
      deactivatedUntilDate: dateTimeSchema.nullable(),
      deactivationReason: z.string(),
      deactivatedOnDate: dateTimeSchema,
      deactivatedBy: z.string(),
    })
    .nullable(),
});
const remediationPageSchema = z.object({
  results: z.object({
    data: z.array(z.object({ id: z.string() }).passthrough()),
    pageInfo: z.object({
      hasNextPage: z.boolean(),
      endCursor: z.string().nullable().optional(),
    }),
  }),
});
const remediationQueryKeys = new Set([
  "pageSize",
  "pageCursor",
  "integrationId",
  "severity",
  "isRemediatedOnTime",
  "remediatedAfterDate",
  "remediatedBeforeDate",
]);

export function requireNonempty(value: string, option: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new CliError(`${option} must not be empty.`);
  return trimmed;
}

export function vulnerabilityDeactivationUpdate(options: {
  id: string;
  reason: string;
  reactivateWhenFixable: string;
  until?: string;
}) {
  const id = requireNonempty(options.id, "Vulnerability ID");
  const deactivateReason = requireNonempty(options.reason, "--reason");
  if (options.reactivateWhenFixable !== "true" && options.reactivateWhenFixable !== "false") {
    throw new CliError("--reactivate-when-fixable must be true or false.");
  }
  if (options.until !== undefined) {
    if (!RFC3339_SECONDS.test(options.until) || !dateTimeSchema.safeParse(options.until).success) {
      throw new CliError("--until must be an RFC 3339 date-time with seconds and a timezone.");
    }
    if (Date.parse(options.until) <= Date.now()) {
      throw new CliError("--until must be in the future.");
    }
  }
  return {
    id,
    deactivateReason,
    shouldReactivateWhenFixable: options.reactivateWhenFixable === "true",
    ...(options.until === undefined ? {} : { deactivateUntilDate: options.until }),
  };
}

export async function readVulnerabilityState(client: Pick<VantaClient, "request">, id: string) {
  const response = await client.request({ path: `/v1/vulnerabilities/${encodeURIComponent(id)}` });
  const parsed = vulnerabilityStateSchema.safeParse(response);
  if (!parsed.success || parsed.data.id !== id) {
    throw new CliError(
      "Vulnerability read returned a mismatched ID or missing deactivation metadata.",
    );
  }
  const metadata = parsed.data.deactivateMetadata;
  if (metadata !== null) {
    const indefinite = metadata.isVulnDeactivatedIndefinitely;
    const expiry = metadata.deactivatedUntilDate;
    if (indefinite !== (expiry === null) || (expiry !== null && Date.parse(expiry) <= Date.now())) {
      throw new CliError(
        "Vulnerability deactivation metadata is contradictory or expired. Refresh its state in Vanta before retrying.",
      );
    }
  }
  return parsed.data;
}

export async function findRemediation(
  client: Pick<VantaClient, "request">,
  id: string,
  query: RequestOptions["query"],
  maxPages: number,
) {
  for (const key of Object.keys(query ?? {})) {
    if (!remediationQueryKeys.has(key)) {
      throw new CliError(`Unsupported remediation lookup query parameter: ${key}.`);
    }
  }
  if (Array.isArray(query?.pageCursor)) throw new CliError("Use only one pageCursor.");
  let pageCursor = query?.pageCursor;
  const pagination = new PaginationGuard("Remediation lookup", maxPages);
  pagination.rememberCursor(pageCursor);
  do {
    pagination.startPage();
    const response = await client.request({
      path: "/v1/vulnerability-remediations",
      query: { ...query, pageSize: query?.pageSize ?? "100", pageCursor },
    });
    const parsed = remediationPageSchema.safeParse(response);
    if (!parsed.success) {
      throw new CliError(`Malformed remediation lookup page ${pagination.pagesFetched()}.`);
    }
    const target = parsed.data.results.data.find((item) => item.id === id);
    if (target) return target;
    pageCursor = pagination.nextCursor(parsed.data.results.pageInfo);
  } while (pageCursor !== undefined);
  throw new CliError(
    `Remediation ${id} was not found. The filtered scan completed${query?.pageCursor ? " from the supplied starting cursor" : ""}.`,
  );
}
