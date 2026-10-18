import type { VantaClient } from "./api.ts";
import { requestAll } from "./pagination.ts";

export { requestAll, DEFAULT_REQUEST_ALL_MAX_PAGES } from "./pagination.ts";

export type FrameworkMatch = "selected" | "none";

type TestOwner = {
  id?: string;
  displayName?: string;
  emailAddress?: string;
} | null;

export type VantaTest = {
  id: string;
  name: string;
  category?: string;
  status?: string;
  remediationStatusInfo?: {
    status?: string;
    soonestRemediateByDate?: string | null;
    itemCount?: number | null;
  };
  owner?: TestOwner;
};

export type VantaDocument = {
  id: string;
  ownerId?: string | null;
  category?: string;
  title: string;
  uploadStatus?: string;
  uploadStatusDate?: string | null;
  nextRenewalDate?: string | null;
  url?: string;
};

export type VantaPerson = {
  id: string;
  emailAddress?: string;
  name?: {
    display?: string;
  };
};

const DASHBOARD_STATUS_DEFS = [
  { id: "overdue", vanta: "OVERDUE", sort: 0, linear: "High", defaultFailing: true },
  { id: "due-soon", vanta: "DUE_SOON", sort: 1, linear: "Medium", defaultFailing: true },
  { id: "needs-remediation", vanta: "NEEDS_WORK", sort: 2, linear: "Medium", defaultFailing: true },
  { id: "upcoming", vanta: undefined, sort: 3, linear: "Low", defaultFailing: false },
] as const;

export type DashboardStatus = (typeof DASHBOARD_STATUS_DEFS)[number]["id"];
type LinearPriority = (typeof DASHBOARD_STATUS_DEFS)[number]["linear"];

export const DASHBOARD_STATUS_IDS: DashboardStatus[] = DASHBOARD_STATUS_DEFS.map(
  (status) => status.id,
);

export const DEFAULT_FAILING_TEST_STATUSES: DashboardStatus[] = DASHBOARD_STATUS_DEFS.filter(
  (status) => status.defaultFailing,
).map((status) => status.id);

export const DASHBOARD_STATUS_HELP = formatStatusHelp(DASHBOARD_STATUS_IDS);

const STATUS_BY_ID = Object.fromEntries(
  DASHBOARD_STATUS_DEFS.map((status) => [status.id, status]),
) as Record<DashboardStatus, (typeof DASHBOARD_STATUS_DEFS)[number]>;

const STATUS_BY_VANTA = new Map<string, DashboardStatus>(
  DASHBOARD_STATUS_DEFS.flatMap((status) =>
    status.vanta === undefined ? [] : [[status.vanta, status.id] as const],
  ),
);

export function isDashboardStatus(value: string): value is DashboardStatus {
  return Object.hasOwn(STATUS_BY_ID, value);
}

export type DashboardRowType = "automated" | "document";

export type DashboardRow = {
  ticketKey: string;
  name: string;
  type: DashboardRowType;
  status: DashboardStatus;
  ownerName?: string;
  ownerId?: string;
  ownerEmail?: string;
  category?: string;
  frameworks: string[];
  frameworkMatch: FrameworkMatch;
  failingEntities?: string | number;
  dueDate?: string;
  source: "tests" | "documents";
  sourceId: string;
  url?: string;
};

export type FailingTestsDashboard = {
  summary: {
    total: number;
    unmapped: number;
    byType: Record<DashboardRowType, number>;
    byStatus: Record<DashboardStatus, number>;
  };
  data: DashboardRow[];
};

export type FailingTestsDashboardOptions = {
  frameworks: string[];
  statuses: DashboardStatus[];
  includeUpcoming?: boolean;
  owners?: string[];
  now?: Date;
};

export type LinearTicketPrep = {
  summary: FailingTestsDashboard["summary"];
  tickets: Array<{
    ticketKey: string;
    title: string;
    description: string;
    labels: string[];
    priority: LinearPriority;
    source: DashboardRow["source"];
    sourceId: string;
    dueDate?: string;
    ownerEmail?: string;
    url?: string;
  }>;
};

export async function buildFailingTestsDashboard(
  client: VantaClient,
  options: FailingTestsDashboardOptions,
): Promise<FailingTestsDashboard> {
  const now = options.now ?? new Date();
  const statuses = options.includeUpcoming
    ? [...new Set([...options.statuses, "upcoming" as const])]
    : options.statuses;
  const statusSet = new Set(statuses);
  const peopleById = await peopleByIdMap(client);
  const automated = await automatedRows(
    client,
    options.frameworks,
    Boolean(options.includeUpcoming),
  );
  const documents = await documentRows(client, options.frameworks, peopleById, now);
  const data = [...automated, ...documents]
    .filter((row) => statusSet.has(row.status))
    .filter((row) => ownerMatches(row, options.owners ?? []))
    .sort(sortDashboardRows);

  return {
    summary: summarize(data),
    data,
  };
}

async function automatedRows(
  client: VantaClient,
  frameworks: string[],
  includeUpcoming: boolean,
): Promise<DashboardRow[]> {
  const byId = new Map<string, DashboardRow>();
  for (const framework of frameworks) {
    const activeTests = await requestAll<VantaTest>(client, "/v1/tests", {
      frameworkFilter: framework,
      statusFilter: "NEEDS_ATTENTION",
    });
    const rolloutTests = includeUpcoming
      ? await requestAll<VantaTest>(client, "/v1/tests", {
          frameworkFilter: framework,
          statusFilter: "NEEDS_ATTENTION",
          isInRollout: "true",
        })
      : [];

    for (const test of [...activeTests, ...rolloutTests]) {
      const row = normalizeTestRow(test, [framework], rolloutTests.includes(test));
      if (!row) continue;
      const existing = byId.get(row.sourceId);
      if (existing) {
        assignFrameworks(existing, mergeFrameworks(existing.frameworks, row.frameworks));
      } else {
        byId.set(row.sourceId, row);
      }
    }
  }

  const unfilteredActiveTests = await requestAll<VantaTest>(client, "/v1/tests", {
    statusFilter: "NEEDS_ATTENTION",
  });
  const unfilteredRolloutTests = includeUpcoming
    ? await requestAll<VantaTest>(client, "/v1/tests", {
        statusFilter: "NEEDS_ATTENTION",
        isInRollout: "true",
      })
    : [];

  for (const test of [...unfilteredActiveTests, ...unfilteredRolloutTests]) {
    if (byId.has(test.id)) continue;
    const row = normalizeTestRow(test, [], unfilteredRolloutTests.includes(test));
    if (!row) continue;
    byId.set(row.sourceId, row);
  }

  return [...byId.values()];
}

async function documentRows(
  client: VantaClient,
  frameworks: string[],
  people: Map<string, VantaPerson>,
  now: Date,
): Promise<DashboardRow[]> {
  const rows: DashboardRow[] = [];
  for (const framework of frameworks) {
    const documents = await requestAll<VantaDocument>(client, "/v1/documents", {
      frameworkMatchesAny: framework,
      statusMatchesAny: "Needs document",
    });
    rows.push(
      ...documents.map((document) => normalizeDocumentRow(document, [framework], people, now)),
    );
  }
  return dedupeRows(rows);
}

export function normalizeTestRow(
  test: VantaTest,
  frameworks: string[],
  isRollout = false,
): DashboardRow | undefined {
  const status = normalizeTestStatus(test, isRollout);
  if (!status) return undefined;
  return {
    ticketKey: ticketKey("tests", test.id),
    name: test.name,
    type: "automated",
    status,
    ownerName: test.owner?.displayName,
    ownerId: test.owner?.id,
    ownerEmail: test.owner?.emailAddress,
    category: test.category,
    ...frameworkFields(frameworks),
    failingEntities: failingEntitiesLabel(test),
    dueDate: test.remediationStatusInfo?.soonestRemediateByDate ?? undefined,
    source: "tests",
    sourceId: test.id,
  };
}

export function normalizeTestStatus(
  test: VantaTest,
  isRollout = false,
): DashboardStatus | undefined {
  if (isRollout) return "upcoming";
  const status = test.remediationStatusInfo?.status;
  if (!status) return undefined;
  return STATUS_BY_VANTA.get(status);
}

export function normalizeDocumentRow(
  document: VantaDocument,
  frameworks: string[],
  people: Map<string, VantaPerson>,
  now: Date,
): DashboardRow {
  const owner = document.ownerId ? people.get(document.ownerId) : undefined;
  const dueDate = documentDueDate(document);
  return {
    ticketKey: ticketKey("documents", document.id),
    name: document.title,
    type: "document",
    status: normalizeDocumentStatus(document, now),
    ownerName: owner?.name?.display,
    ownerId: document.ownerId ?? undefined,
    ownerEmail: owner?.emailAddress,
    category: document.category,
    ...frameworkFields(frameworks),
    ...(dueDate ? { dueDate } : {}),
    source: "documents",
    sourceId: document.id,
    url: document.url,
  };
}

export function normalizeDocumentStatus(document: VantaDocument, now: Date): DashboardStatus {
  const dueDate = documentDueDate(document);
  if (document.uploadStatus === "Needs document" && dueDate) {
    const statusDate = new Date(dueDate);
    if (statusDate < now) return "overdue";
  }
  return "needs-remediation";
}

export function dedupeRows(rows: DashboardRow[]): DashboardRow[] {
  const bySource = new Map<string, DashboardRow>();
  for (const row of rows) {
    const key = `${row.source}:${row.sourceId}`;
    const existing = bySource.get(key);
    if (existing) {
      assignFrameworks(existing, mergeFrameworks(existing.frameworks, row.frameworks));
    } else {
      bySource.set(key, { ...row, ...frameworkFields(row.frameworks) });
    }
  }
  return [...bySource.values()];
}

export function toLinearTicketPrep(dashboard: FailingTestsDashboard): LinearTicketPrep {
  return {
    summary: dashboard.summary,
    tickets: dashboard.data.map((row) => ({
      ticketKey: row.ticketKey,
      title: `[Vanta] ${row.name}`,
      description: linearDescription(row),
      labels: linearLabels(row),
      priority: linearPriority(row.status),
      source: row.source,
      sourceId: row.sourceId,
      ...(row.dueDate ? { dueDate: row.dueDate } : {}),
      ownerEmail: row.ownerEmail,
      url: row.url,
    })),
  };
}

function failingEntitiesLabel(test: VantaTest): string | number | undefined {
  const count = test.remediationStatusInfo?.itemCount;
  if (count === undefined || count === null) return undefined;
  if (count === 0) return "--";
  if (count === 1) return "1 item";
  return `${count} items`;
}

function ticketKey(source: DashboardRow["source"], sourceId: string): string {
  return `vanta:${source}:${sourceId}`;
}

function documentDueDate(document: VantaDocument): string | undefined {
  for (const value of [document.uploadStatusDate, document.nextRenewalDate]) {
    if (!value) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return value;
  }
  return undefined;
}

function ownerMatches(row: DashboardRow, owners: string[]): boolean {
  if (owners.length === 0) return true;
  const normalizedOwners = owners.map((owner) => owner.toLowerCase());
  const isUnassigned = !row.ownerId && !row.ownerName && !row.ownerEmail;
  if (isUnassigned && normalizedOwners.includes("unassigned")) return true;
  const candidates = [row.ownerId, row.ownerName, row.ownerEmail]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
  return normalizedOwners.some((owner) => candidates.includes(owner));
}

function linearDescription(row: DashboardRow): string {
  const lines = [
    "## Vanta remediation",
    "",
    `- Status: ${row.status}`,
    `- Type: ${row.type}`,
    row.frameworkMatch === "none"
      ? "- Frameworks: none (not attached to selected frameworks)"
      : `- Frameworks: ${row.frameworks.join(", ")}`,
    row.category ? `- Category: ${row.category}` : undefined,
    row.ownerName || row.ownerEmail
      ? `- Vanta owner: ${row.ownerName ?? row.ownerEmail}${row.ownerEmail ? ` (${row.ownerEmail})` : ""}`
      : "- Vanta owner: Unassigned",
    row.failingEntities !== undefined ? `- Failing entities: ${row.failingEntities}` : undefined,
    row.dueDate ? `- Due date: ${row.dueDate}` : undefined,
    `- Source: ${row.source}/${row.sourceId}`,
    `- Ticket key: ${row.ticketKey}`,
    row.url ? `- Vanta URL: ${row.url}` : undefined,
  ].filter((line): line is string => line !== undefined);
  return `${lines.join("\n")}\n`;
}

function linearLabels(row: DashboardRow): string[] {
  const labels = ["Compliance"];
  if (row.type === "document") labels.push("Evidence Required");
  if (row.type === "automated") labels.push("Security Review");
  return labels;
}

function linearPriority(status: DashboardStatus): LinearPriority {
  return STATUS_BY_ID[status].linear;
}

async function peopleByIdMap(client: VantaClient): Promise<Map<string, VantaPerson>> {
  const people = await requestAll<VantaPerson>(client, "/v1/people");
  return new Map(people.map((person) => [person.id, person]));
}

function mergeFrameworks(first: string[], second: string[]): string[] {
  return [...new Set([...first, ...second])];
}

function frameworkFields(
  frameworks: string[],
): Pick<DashboardRow, "frameworks" | "frameworkMatch"> {
  return {
    frameworks: [...frameworks],
    frameworkMatch: frameworks.length === 0 ? "none" : "selected",
  };
}

function assignFrameworks(row: DashboardRow, frameworks: string[]): void {
  const next = frameworkFields(frameworks);
  row.frameworks = next.frameworks;
  row.frameworkMatch = next.frameworkMatch;
}

function summarize(data: DashboardRow[]): FailingTestsDashboard["summary"] {
  return {
    total: data.length,
    unmapped: data.filter((row) => row.frameworkMatch === "none").length,
    byType: {
      automated: data.filter((row) => row.type === "automated").length,
      document: data.filter((row) => row.type === "document").length,
    },
    byStatus: Object.fromEntries(
      DASHBOARD_STATUS_IDS.map((status) => [
        status,
        data.filter((row) => row.status === status).length,
      ]),
    ) as Record<DashboardStatus, number>,
  };
}

function sortDashboardRows(left: DashboardRow, right: DashboardRow): number {
  return (
    STATUS_BY_ID[left.status].sort - STATUS_BY_ID[right.status].sort ||
    left.name.localeCompare(right.name)
  );
}

function formatStatusHelp(statuses: DashboardStatus[]): string {
  const last = statuses.at(-1);
  if (!last) return "";
  if (statuses.length === 1) return last;
  return `${statuses.slice(0, -1).join(", ")}, or ${last}`;
}
