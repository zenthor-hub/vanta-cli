import type { VantaClient } from "./api.ts";
import { CliError } from "./errors.ts";
import { requestAllPages } from "./pagination.ts";

export const RESOURCE_UPDATE_BATCH_SIZE = 50;

export type ResourceKindCapabilities = {
  integrationId: string;
  resourceKind: string;
  isScopable: boolean;
  canUpdateOwner: boolean;
  canUpdateDescription: boolean;
};

export type IntegrationResource = {
  resourceId?: unknown;
  displayName?: unknown;
  connectionId?: unknown;
  inScope?: unknown;
  owner?: unknown;
  description?: unknown;
  account?: unknown;
  accountName?: unknown;
  accountId?: unknown;
  awsAccountNumber?: unknown;
  region?: unknown;
};

export type ResourceUpdate = {
  id: string;
  inScope?: boolean;
  ownerId?: string;
  description?: string;
};

export type ResourceSelection = {
  ids: string[];
  region?: string;
  account?: string;
  connectionId?: string;
  displayNamePattern?: string;
  inScope?: boolean;
};

export type ResourceMutation = {
  inScope?: boolean;
  ownerId?: string;
  description?: string;
};

export type PlannedResourceChange = {
  id: string;
  displayName?: string;
  region?: string;
  account?: string;
  connectionId?: string;
  inScope?: boolean;
  update: ResourceUpdate;
};

type ListMatch = {
  scanned: number;
  matched: number;
  unchanged: number;
  changes: PlannedResourceChange[];
  missingIds: string[];
  pagesFetched: number;
};

export function resourceKindsPath(integrationId: string): string {
  return `/v1/integrations/${encodeURIComponent(integrationId)}/resource-kinds`;
}

export function resourceKindPath(integrationId: string, resourceKind: string): string {
  return `${resourceKindsPath(integrationId)}/${encodeURIComponent(resourceKind)}`;
}

export function integrationResourcesPath(integrationId: string, resourceKind: string): string {
  return `${resourceKindPath(integrationId, resourceKind)}/resources`;
}

export function parseBooleanFlag(name: string, value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "yes" || normalized === "1") return true;
  if (normalized === "false" || normalized === "no" || normalized === "0") return false;
  throw new CliError(`${name} must be true or false.`);
}

export function assertResourceSelection(selection: ResourceSelection): void {
  const bounded =
    selection.ids.length > 0 ||
    selection.region !== undefined ||
    selection.account !== undefined ||
    selection.connectionId !== undefined ||
    selection.displayNamePattern !== undefined ||
    selection.inScope !== undefined;
  if (!bounded) {
    throw new CliError(
      "Select resources with --id and/or a filter (--region, --account, --connection-id, --display-name, --in-scope).",
    );
  }
}

export function assertResourceMutation(mutation: ResourceMutation): void {
  if (
    mutation.inScope === undefined &&
    mutation.ownerId === undefined &&
    mutation.description === undefined
  ) {
    throw new CliError("Set at least one of --set-in-scope, --owner-id, or --description.");
  }
  if (mutation.ownerId !== undefined && mutation.ownerId.trim() === "") {
    throw new CliError("--owner-id must not be empty.");
  }
}

export function assertKindAllowsMutation(
  kind: ResourceKindCapabilities,
  mutation: ResourceMutation,
): void {
  if (mutation.inScope !== undefined && !kind.isScopable) {
    throw new CliError(
      `${kind.resourceKind} is not scopable. Refusing to set inScope. Vanta reports isScopable=false for this resource kind.`,
    );
  }
  if (mutation.ownerId !== undefined && !kind.canUpdateOwner) {
    throw new CliError(
      `${kind.resourceKind} does not allow owner updates. Refusing to set ownerId. Vanta reports canUpdateOwner=false for this resource kind.`,
    );
  }
  if (mutation.description !== undefined && !kind.canUpdateDescription) {
    throw new CliError(
      `${kind.resourceKind} does not allow description updates. Refusing to set description. Vanta reports canUpdateDescription=false for this resource kind.`,
    );
  }
}

export function compileDisplayNamePattern(pattern: string | undefined): RegExp | undefined {
  if (pattern === undefined) return undefined;
  try {
    return new RegExp(pattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Invalid --display-name pattern: ${message}`);
  }
}

export function resourceAccount(resource: IntegrationResource): string | undefined {
  return firstString(
    resource.account,
    resource.accountName,
    resource.accountId,
    resource.awsAccountNumber,
  );
}

export function resourceMatches(
  resource: IntegrationResource,
  selection: ResourceSelection,
  displayName: RegExp | undefined,
): boolean {
  const id = stringValue(resource.resourceId);
  if (selection.ids.length > 0 && (id === undefined || !selection.ids.includes(id))) return false;
  if (selection.region !== undefined && stringValue(resource.region) !== selection.region) {
    return false;
  }
  if (selection.account !== undefined && resourceAccount(resource) !== selection.account) {
    return false;
  }
  if (
    selection.connectionId !== undefined &&
    stringValue(resource.connectionId) !== selection.connectionId
  ) {
    return false;
  }
  if (selection.inScope !== undefined && resource.inScope !== selection.inScope) return false;
  if (displayName && !displayName.test(stringValue(resource.displayName) ?? "")) return false;
  return id !== undefined;
}

export function planResourceChange(
  resource: IntegrationResource,
  mutation: ResourceMutation,
): PlannedResourceChange | undefined {
  const id = stringValue(resource.resourceId);
  if (!id) return undefined;
  const update = updateForResource(id, resource, mutation);
  if (!update) return undefined;
  return {
    id,
    displayName: stringValue(resource.displayName),
    region: stringValue(resource.region),
    account: resourceAccount(resource),
    connectionId: stringValue(resource.connectionId),
    inScope: typeof resource.inScope === "boolean" ? resource.inScope : undefined,
    update,
  };
}

export function updatesFromIds(ids: string[], mutation: ResourceMutation): ResourceUpdate[] {
  return ids.map((id) => updateFromMutation(id, mutation));
}

export function batchResourceUpdates(updates: ResourceUpdate[]): ResourceUpdate[][] {
  const batches: ResourceUpdate[][] = [];
  for (let index = 0; index < updates.length; index += RESOURCE_UPDATE_BATCH_SIZE) {
    batches.push(updates.slice(index, index + RESOURCE_UPDATE_BATCH_SIZE));
  }
  return batches;
}

export function parseKindCapabilities(value: unknown): ResourceKindCapabilities {
  if (!isRecord(value)) throw new CliError("Resource kind response was not an object.");
  const integrationId = stringValue(value.integrationId);
  const resourceKind = stringValue(value.resourceKind);
  if (!integrationId || !resourceKind) {
    throw new CliError("Resource kind response did not include integrationId and resourceKind.");
  }
  return {
    integrationId,
    resourceKind,
    isScopable: value.isScopable === true,
    canUpdateOwner: value.canUpdateOwner === true,
    canUpdateDescription: value.canUpdateDescription === true,
  };
}

export async function findResourceChanges(
  client: Pick<VantaClient, "request">,
  integrationId: string,
  resourceKind: string,
  selection: ResourceSelection,
  mutation: ResourceMutation,
  maxPages: number,
): Promise<ListMatch> {
  const displayName = compileDisplayNamePattern(selection.displayNamePattern);
  const page = await requestAllPages<IntegrationResource>(
    client,
    integrationResourcesPath(integrationId, resourceKind),
    {
      connectionId: selection.connectionId,
      isInScope: selection.inScope === undefined ? undefined : selection.inScope ? "true" : "false",
    },
    { maxPages, pageSize: 100 },
  );
  const changes: PlannedResourceChange[] = [];
  let matched = 0;
  const seenIds = new Set<string>();
  for (const resource of page.results.data) {
    if (!resourceMatches(resource, selection, displayName)) continue;
    matched += 1;
    const id = stringValue(resource.resourceId);
    if (id) seenIds.add(id);
    const change = planResourceChange(resource, mutation);
    if (change) changes.push(change);
  }
  return {
    scanned: page.results.data.length,
    matched,
    unchanged: matched - changes.length,
    changes,
    missingIds: selection.ids.filter((id) => !seenIds.has(id)),
    pagesFetched: page.scan.pagesFetched,
  };
}

type BulkUpdateResult = {
  id?: string;
  status?: string;
  message?: string;
};

export async function executeIntegrationResourceUpdate(
  client: Pick<VantaClient, "request">,
  input: {
    integrationId: string;
    resourceKind: string;
    selection: ResourceSelection;
    mutation: ResourceMutation;
    maxPages: number;
    apply: boolean;
    confirm: (summary: string) => Promise<void>;
  },
): Promise<Record<string, unknown>> {
  assertResourceSelection(input.selection);
  assertResourceMutation(input.mutation);
  const kindResponse = await client.request<unknown>({
    path: resourceKindPath(input.integrationId, input.resourceKind),
    query: { connectionId: input.selection.connectionId },
  });
  const kind = parseKindCapabilities(kindResponse);
  assertKindAllowsMutation(kind, input.mutation);

  const listed = usesResourceList(input.selection);
  const match = listed
    ? await findResourceChanges(
        client,
        input.integrationId,
        input.resourceKind,
        input.selection,
        input.mutation,
        input.maxPages,
      )
    : undefined;
  const updates = match
    ? match.changes.map((change) => change.update)
    : updatesFromIds(input.selection.ids, input.mutation);
  const path = integrationResourcesPath(input.integrationId, input.resourceKind);
  const requests = batchResourceUpdates(updates).map((batch) => ({
    method: "PATCH",
    path,
    body: { updates: batch },
  }));
  const base = {
    mutation: true,
    kind,
    selector: "listed-at-execution-time",
    scanned: match?.scanned,
    matched: match?.matched ?? input.selection.ids.length,
    unchanged: match?.unchanged ?? 0,
    missingIds: match?.missingIds ?? [],
    pagesFetched: match?.pagesFetched,
    resources: match?.changes,
    updates,
  };

  if (updates.length === 0) {
    return {
      ...base,
      dryRun: !input.apply,
      applied: false,
      requiresApply: false,
      summary: emptySummary(input.integrationId, input.resourceKind, match),
      guidance: "No PATCH request is sent when every match is unchanged or none match.",
    };
  }

  if (!input.apply) {
    return {
      ...base,
      dryRun: true,
      requiresApply: true,
      confirmationRequired: true,
      summary: changeSummary(
        input.integrationId,
        input.resourceKind,
        updates.length,
        input.mutation,
      ),
      requests,
      guidance:
        "Pass --apply to execute this mutation. Filter matches are listed again at apply time, then sent in batches of at most 50.",
    };
  }

  await input.confirm(
    [
      ...targetLines(updates, match?.changes),
      `${changeSummary(input.integrationId, input.resourceKind, updates.length, input.mutation)} ${requests.length} PATCH request(s).`,
    ].join("\n"),
  );

  const results: BulkUpdateResult[] = [];
  for (const request of requests) {
    const response = await client.request<unknown>(request);
    results.push(...parseBulkResults(response));
  }
  const succeeded = results.filter((result) => result.status === "SUCCESS").length;
  const failed = results.length - succeeded;
  if (failed > 0) process.exitCode = 1;
  return {
    ...base,
    dryRun: false,
    applied: true,
    requiresApply: false,
    batches: requests.length,
    succeeded,
    failed,
    results,
    summary: `Updated ${input.integrationId} ${input.resourceKind}: ${succeeded} succeeded, ${failed} failed.`,
  };
}

function usesResourceList(selection: ResourceSelection): boolean {
  return (
    selection.region !== undefined ||
    selection.account !== undefined ||
    selection.connectionId !== undefined ||
    selection.displayNamePattern !== undefined ||
    selection.inScope !== undefined
  );
}

function updateForResource(
  id: string,
  resource: IntegrationResource,
  mutation: ResourceMutation,
): ResourceUpdate | undefined {
  const update = updateFromMutation(id, mutation);
  const inScopeUnchanged =
    update.inScope === undefined ||
    (typeof resource.inScope === "boolean" && resource.inScope === update.inScope);
  const ownerUnchanged =
    update.ownerId === undefined ||
    (typeof resource.owner === "string" && resource.owner === update.ownerId);
  const descriptionUnchanged =
    update.description === undefined ||
    (typeof resource.description === "string" && resource.description === update.description);
  if (inScopeUnchanged && ownerUnchanged && descriptionUnchanged) return undefined;
  return update;
}

function updateFromMutation(id: string, mutation: ResourceMutation): ResourceUpdate {
  return {
    id,
    ...(mutation.inScope === undefined ? {} : { inScope: mutation.inScope }),
    ...(mutation.ownerId === undefined ? {} : { ownerId: mutation.ownerId }),
    ...(mutation.description === undefined ? {} : { description: mutation.description }),
  };
}

function emptySummary(
  integrationId: string,
  resourceKind: string,
  match: ListMatch | undefined,
): string {
  if (!match || match.matched === 0) {
    return `No ${integrationId} ${resourceKind} resources matched.`;
  }
  return `No ${integrationId} ${resourceKind} resources need changes.`;
}

function changeSummary(
  integrationId: string,
  resourceKind: string,
  count: number,
  mutation: ResourceMutation,
): string {
  const changes = [
    mutation.inScope === undefined ? undefined : `inScope=${mutation.inScope}`,
    mutation.ownerId === undefined ? undefined : `ownerId=${mutation.ownerId}`,
    mutation.description === undefined ? undefined : "description",
  ].filter((part) => part !== undefined);
  return `Update ${count} ${integrationId} ${resourceKind} resource(s): ${changes.join(", ")}.`;
}

// Lists every PATCH target for the apply confirmation, so resources newly
// matched since the dry-run are visible before the user approves.
function targetLines(updates: ResourceUpdate[], changes: PlannedResourceChange[] = []): string[] {
  const names = new Map(changes.map((change) => [change.id, change.displayName]));
  return updates.map((update) => {
    const name = names.get(update.id);
    return name ? `  ${name} (${update.id})` : `  ${update.id}`;
  });
}

function parseBulkResults(response: unknown): BulkUpdateResult[] {
  if (!isRecord(response) || !Array.isArray(response.results)) {
    throw new CliError("Bulk resource update response did not include a results array.");
  }
  return response.results.map((entry) => {
    if (!isRecord(entry)) return { status: "ERROR", message: "Result entry was not an object." };
    return {
      id: stringValue(entry.id),
      status: stringValue(entry.status) ?? "ERROR",
      message: stringValue(entry.message),
    };
  });
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const parsed = stringValue(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
