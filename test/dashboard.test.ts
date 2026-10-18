import { describe, expect, test } from "bun:test";

import {
  buildFailingTestsDashboard,
  dedupeRows,
  DEFAULT_FAILING_TEST_STATUSES,
  normalizeDocumentRow,
  normalizeDocumentStatus,
  normalizeTestStatus,
  toLinearTicketPrep,
  type DashboardRow,
  type VantaTest,
} from "../src/dashboard.ts";
import { CliError } from "../src/errors.ts";
import { parseDashboardFormat, parseDashboardStatuses } from "../src/vanta.ts";

const dueSoonTest: VantaTest = {
  id: "access-reviews-due-soon",
  name: "Access reviews completed on schedule",
  remediationStatusInfo: {
    status: "DUE_SOON",
    soonestRemediateByDate: "2026-07-28T00:00:00.000Z",
    itemCount: 2,
  },
};

const needsWorkTest: VantaTest = {
  id: "approved-gdpr-compliance-policy-exists",
  name: "Company has an approved GDPR Compliance Policy",
  remediationStatusInfo: { status: "NEEDS_WORK", itemCount: 1 },
};

const overdueTest: VantaTest = {
  id: "infra-access-keys-rotated",
  name: "Enabled IAM User Access Keys must not be older than 90 days",
  remediationStatusInfo: {
    status: "OVERDUE",
    soonestRemediateByDate: "2026-02-25T12:36:19.547Z",
    itemCount: 5,
  },
  owner: {
    id: "user_alex",
    displayName: "Alex Rivera",
    emailAddress: "alex@example.com",
  },
};

const mixedStatusTests: VantaTest[] = [
  {
    id: "overdue-test",
    name: "Overdue test",
    remediationStatusInfo: { status: "OVERDUE", itemCount: 1 },
  },
  {
    id: "due-soon-test",
    name: "Due soon test",
    remediationStatusInfo: {
      status: "DUE_SOON",
      soonestRemediateByDate: "2026-07-28T00:00:00.000Z",
      itemCount: 1,
    },
  },
  {
    id: "needs-work-test",
    name: "Needs work test",
    remediationStatusInfo: { status: "NEEDS_WORK", itemCount: 1 },
  },
];

describe("dashboard helpers", () => {
  test("maps document due dates to dashboard statuses", () => {
    const now = new Date("2026-06-24T12:00:00.000Z");

    expect(
      normalizeDocumentStatus(
        {
          id: "doc_1",
          title: "Past due",
          uploadStatus: "Needs document",
          uploadStatusDate: "2026-06-01T00:00:00.000Z",
        },
        now,
      ),
    ).toBe("overdue");
    expect(
      normalizeDocumentStatus(
        { id: "doc_2", title: "No date", uploadStatus: "Needs document", uploadStatusDate: null },
        now,
      ),
    ).toBe("needs-remediation");
  });

  test("maps document date fields to dashboard row due dates", () => {
    const people = new Map();
    const now = new Date("2026-06-24T12:00:00.000Z");

    expect(
      normalizeDocumentRow(
        {
          id: "doc_1",
          title: "Past due upload",
          uploadStatus: "Needs document",
          uploadStatusDate: "2026-06-01T00:00:00.000Z",
          nextRenewalDate: "2026-06-15T00:00:00.000Z",
        },
        ["iso27001_2022"],
        people,
        now,
      ),
    ).toMatchObject({
      status: "overdue",
      dueDate: "2026-06-01T00:00:00.000Z",
    });

    expect(
      normalizeDocumentRow(
        {
          id: "doc_2",
          title: "Renewal due",
          uploadStatus: "Needs document",
          uploadStatusDate: null,
          nextRenewalDate: "2026-06-09",
        },
        ["soc2"],
        people,
        now,
      ),
    ).toMatchObject({
      status: "overdue",
      dueDate: "2026-06-09",
    });

    expect(
      normalizeDocumentRow(
        {
          id: "doc_3",
          title: "No date",
          uploadStatus: "Needs document",
          uploadStatusDate: null,
          nextRenewalDate: null,
        },
        ["gdpr"],
        people,
        now,
      ),
    ).not.toHaveProperty("dueDate");
  });

  test("maps automated remediation statuses", () => {
    expect(
      normalizeTestStatus({
        id: "test_1",
        name: "Overdue test",
        remediationStatusInfo: { status: "OVERDUE" },
      }),
    ).toBe("overdue");
    expect(
      normalizeTestStatus({
        id: "test_2",
        name: "Due soon test",
        remediationStatusInfo: { status: "DUE_SOON" },
      }),
    ).toBe("due-soon");
    expect(
      normalizeTestStatus({
        id: "test_3",
        name: "Needs work test",
        remediationStatusInfo: { status: "NEEDS_WORK" },
      }),
    ).toBe("needs-remediation");
    expect(normalizeTestStatus({ id: "test_4", name: "Rollout test" }, true)).toBe("upcoming");
    expect(
      normalizeTestStatus(
        {
          id: "test_5",
          name: "Rollout due soon test",
          remediationStatusInfo: { status: "DUE_SOON" },
        },
        true,
      ),
    ).toBe("upcoming");
  });

  test("dedupes dashboard rows and merges frameworks", () => {
    const rows: DashboardRow[] = [
      row({ sourceId: "shared", frameworks: ["gdpr"] }),
      row({ sourceId: "shared", frameworks: ["soc2"] }),
    ];

    expect(dedupeRows(rows)).toEqual([row({ sourceId: "shared", frameworks: ["gdpr", "soc2"] })]);
  });

  test("formats dashboard rows as Linear ticket prep", () => {
    const prep = toLinearTicketPrep({
      summary: {
        total: 2,
        unmapped: 0,
        byType: { automated: 1, document: 1 },
        byStatus: { overdue: 1, "due-soon": 1, "needs-remediation": 0, upcoming: 0 },
      },
      data: [
        row({
          ticketKey: "vanta:documents:doc_1",
          name: "Proof of completed access review",
          type: "document",
          status: "overdue",
          source: "documents",
          sourceId: "doc_1",
          ownerEmail: "sam@example.com",
          frameworks: ["iso27001_2022"],
          dueDate: "2026-06-09",
        }),
        row({
          ticketKey: "vanta:tests:test_due_soon",
          name: "Access reviews completed on schedule",
          type: "automated",
          status: "due-soon",
          source: "tests",
          sourceId: "test_due_soon",
          frameworks: ["soc2"],
          dueDate: "2026-07-28T00:00:00.000Z",
        }),
      ],
    });

    const overdueTicket = prep.tickets[0];
    if (!overdueTicket) throw new Error("Expected overdue Linear ticket");

    expect(overdueTicket).toMatchObject({
      ticketKey: "vanta:documents:doc_1",
      title: "[Vanta] Proof of completed access review",
      labels: ["Compliance", "Evidence Required"],
      priority: "High",
      dueDate: "2026-06-09",
      ownerEmail: "sam@example.com",
    });
    expect(overdueTicket.description).toContain("- Due date: 2026-06-09");
    expect(overdueTicket.description).toContain("- Frameworks: iso27001_2022");

    const dueSoonTicket = prep.tickets[1];
    if (!dueSoonTicket) throw new Error("Expected due-soon Linear ticket");

    expect(dueSoonTicket).toMatchObject({
      ticketKey: "vanta:tests:test_due_soon",
      priority: "Medium",
      dueDate: "2026-07-28T00:00:00.000Z",
    });
    expect(dueSoonTicket.description).toContain("- Status: due-soon");
    expect(dueSoonTicket.description).toContain("- Due date: 2026-07-28T00:00:00.000Z");
  });

  test("includes unfiltered failing tests missed by framework-filtered results", async () => {
    const client = {
      request: async ({ path, query }: { path: string; query?: Record<string, string> }) => {
        if (path === "/v1/people" || path === "/v1/documents") return page([]);
        if (path === "/v1/tests" && query?.frameworkFilter === "gdpr") {
          return page([needsWorkTest, dueSoonTest]);
        }
        if (path === "/v1/tests" && query?.statusFilter === "NEEDS_ATTENTION") {
          return page([needsWorkTest, dueSoonTest, overdueTest]);
        }
        throw new Error(`Unexpected request: ${path} ${JSON.stringify(query)}`);
      },
    };

    const dashboard = await buildFailingTestsDashboard(client as never, {
      frameworks: ["gdpr"],
      statuses: DEFAULT_FAILING_TEST_STATUSES,
      owners: [],
      now: new Date("2026-06-24T12:00:00.000Z"),
    });

    expect(dashboard.summary).toMatchObject({
      total: 3,
      unmapped: 1,
      byType: { automated: 3, document: 0 },
      byStatus: { overdue: 1, "due-soon": 1, "needs-remediation": 1, upcoming: 0 },
    });
    expect(dashboard.data.map((row) => row.status)).toEqual([
      "overdue",
      "due-soon",
      "needs-remediation",
    ]);
    expect(dashboard.data).toContainEqual(
      expect.objectContaining({
        sourceId: "infra-access-keys-rotated",
        name: "Enabled IAM User Access Keys must not be older than 90 days",
        status: "overdue",
        ownerEmail: "alex@example.com",
        frameworks: [],
        frameworkMatch: "none",
      }),
    );
    expect(dashboard.data).toContainEqual(
      expect.objectContaining({
        sourceId: "access-reviews-due-soon",
        status: "due-soon",
        dueDate: "2026-07-28T00:00:00.000Z",
        frameworks: ["gdpr"],
        frameworkMatch: "selected",
      }),
    );
    expect(
      dashboard.data.find((row) => row.sourceId === "approved-gdpr-compliance-policy-exists"),
    ).toMatchObject({
      frameworks: ["gdpr"],
      frameworkMatch: "selected",
    });

    const unmappedPrep = toLinearTicketPrep(dashboard);
    const unmappedTicket = unmappedPrep.tickets.find(
      (ticket) => ticket.sourceId === "infra-access-keys-rotated",
    );
    if (!unmappedTicket) throw new Error("Expected unmapped Linear ticket");
    expect(unmappedTicket.description).toContain(
      "- Frameworks: none (not attached to selected frameworks)",
    );
    expect(unmappedTicket.description).not.toContain("unfiltered");
  });

  test("filters to due-soon rows when only that status is selected", async () => {
    const client = {
      request: async ({ path, query }: { path: string; query?: Record<string, string> }) => {
        if (path === "/v1/people" || path === "/v1/documents") return page([]);
        if (path === "/v1/tests") return page(mixedStatusTests);
        throw new Error(`Unexpected request: ${path} ${JSON.stringify(query)}`);
      },
    };

    const dashboard = await buildFailingTestsDashboard(client as never, {
      frameworks: ["soc2"],
      statuses: ["due-soon"],
      owners: [],
      now: new Date("2026-06-24T12:00:00.000Z"),
    });

    expect(dashboard.summary).toMatchObject({
      total: 1,
      byStatus: { overdue: 0, "due-soon": 1, "needs-remediation": 0, upcoming: 0 },
    });
    expect(dashboard.data).toEqual([
      expect.objectContaining({
        sourceId: "due-soon-test",
        status: "due-soon",
        dueDate: "2026-07-28T00:00:00.000Z",
      }),
    ]);
  });
});

describe("dashboard CLI parsing", () => {
  test("parses dashboard statuses", () => {
    expect(parseDashboardStatuses(["overdue", "needs-remediation", "overdue"])).toEqual([
      "overdue",
      "needs-remediation",
    ]);
    expect(parseDashboardStatuses(["due-soon"])).toEqual(["due-soon"]);
  });

  test("defaults failing-test statuses to the dashboard policy table", () => {
    expect(DEFAULT_FAILING_TEST_STATUSES).toEqual(["overdue", "due-soon", "needs-remediation"]);
    expect(parseDashboardStatuses(DEFAULT_FAILING_TEST_STATUSES)).toEqual(
      DEFAULT_FAILING_TEST_STATUSES,
    );
  });

  test("rejects invalid dashboard statuses", () => {
    expect(() => parseDashboardStatuses(["bad-status"])).toThrow(CliError);
  });

  test("parses dashboard output formats", () => {
    expect(parseDashboardFormat("linear")).toBe("linear");
    expect(parseDashboardFormat("dashboard")).toBe("dashboard");
  });

  test("rejects invalid dashboard output formats", () => {
    expect(() => parseDashboardFormat("csv")).toThrow(CliError);
  });
});

function row(overrides: Partial<DashboardRow>): DashboardRow {
  const next: DashboardRow = {
    ticketKey: "vanta:tests:shared",
    name: "Shared row",
    type: "automated",
    status: "needs-remediation",
    frameworks: [],
    frameworkMatch: "none",
    source: "tests",
    sourceId: "shared",
    ...overrides,
  };
  return {
    ...next,
    frameworkMatch:
      overrides.frameworkMatch ?? (next.frameworks.length === 0 ? "none" : "selected"),
  };
}

function page<T>(data: T[]) {
  return {
    results: {
      data,
      pageInfo: { hasNextPage: false },
    },
  };
}
