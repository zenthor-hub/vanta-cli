import { describe, expect, test } from "bun:test";

import {
  auditCodeChangesPath,
  listAuditCodeChanges,
  parseCodeChangeDate,
  parseCodeChangeMaxPages,
  parseCodeChangePageSize,
  parseCodeChangeRepository,
  parseCodeChangeSources,
  type AuditorClient,
} from "../src/audits.ts";
import { DEFAULT_AUDITOR_SCOPE, DEFAULT_BASE_URL, loadAuditorConfig } from "../src/config.ts";
import { CliError } from "../src/errors.ts";

describe("Auditor API configuration", () => {
  test("loads separately scoped Auditor API credentials", () => {
    const config = loadAuditorConfig({
      configPath: "/tmp/vanta-cli-test-missing-config.json",
      env: {
        VANTA_AUDITOR_CLIENT_ID: "vci_auditor_test",
        VANTA_AUDITOR_CLIENT_SECRET: "vcs_auditor_test",
        VANTA_AUDITOR_TOKEN_CACHE_PATH: "/tmp/vanta-auditor-token.json",
      },
    });

    expect(config).toMatchObject({
      baseUrl: DEFAULT_BASE_URL,
      scope: DEFAULT_AUDITOR_SCOPE,
      clientId: "vci_auditor_test",
      clientSecret: "vcs_auditor_test",
      tokenCachePath: "/tmp/vanta-auditor-token.json",
    });
  });
});

describe("audit code-change helpers", () => {
  test("builds encoded Auditor API paths and validates documented filters", () => {
    expect(auditCodeChangesPath("audit/a")).toBe("/v1/audits/audit%2Fa/assets/code-changes");
    expect(parseCodeChangeSources(["GitHub", "github", "gitlab"])).toEqual(["github", "gitlab"]);
    expect(parseCodeChangePageSize("100")).toBe(100);
    expect(parseCodeChangeDate("2026-12-31T23:59:59Z", "--closed-after")).toBe(
      "2026-12-31T23:59:59Z",
    );
    expect(parseCodeChangeRepository("  acme/api  ")).toBe("acme/api");
    expect(() => parseCodeChangeSources(["github-enterprise"])).toThrow(CliError);
    expect(() => parseCodeChangePageSize("101")).toThrow(CliError);
    expect(() => parseCodeChangeDate("2026-12-31", "--closed-after")).toThrow(CliError);
    expect(() => parseCodeChangeRepository("   ")).toThrow(CliError);
    expect(parseCodeChangeMaxPages()).toBe(50);
    expect(parseCodeChangeMaxPages("3")).toBe(3);
    expect(() => parseCodeChangeMaxPages("0")).toThrow(CliError);
    expect(() => parseCodeChangeMaxPages("101")).toThrow(CliError);
  });

  test("scans bounded pages for exact repository matches", async () => {
    const requests: unknown[] = [];
    const responses = [
      {
        results: {
          data: [
            { id: "change_1", codeChange: "First", repository: "acme/api" },
            { id: "change_2", codeChange: "Second", repository: "acme/other" },
          ],
          pageInfo: { hasNextPage: true, endCursor: "next-page" },
        },
      },
      {
        results: {
          data: [{ id: "change_3", codeChange: "Third", repository: "acme/api" }],
          pageInfo: { hasNextPage: false },
        },
      },
    ];
    const client: AuditorClient = {
      request: async (request) => {
        requests.push(request);
        const response = responses.shift();
        if (!response) throw new Error("Unexpected extra page request");
        return response;
      },
    };

    await expect(
      listAuditCodeChanges(client, "audit_123", {
        search: "vanta",
        sources: ["github"],
        closedAfterDate: "2026-01-01T00:00:00Z",
        closedBeforeDate: "2026-12-31T23:59:59Z",
        pageSize: 50,
        pageCursor: "cursor_1",
        repository: "acme/api",
        maxPages: 5,
      }),
    ).resolves.toEqual({
      results: {
        data: [
          { id: "change_1", codeChange: "First", repository: "acme/api" },
          { id: "change_3", codeChange: "Third", repository: "acme/api" },
        ],
        pageInfo: { hasNextPage: false },
      },
      scan: {
        mode: "repository-filter-all-pages",
        repository: "acme/api",
        pagesFetched: 2,
        complete: true,
      },
    });
    expect(requests).toEqual([
      {
        path: "/v1/audits/audit_123/assets/code-changes",
        query: {
          search: "vanta",
          sourcesMatchesAny: ["github"],
          closedAfterDate: "2026-01-01T00:00:00Z",
          closedBeforeDate: "2026-12-31T23:59:59Z",
          pageSize: "50",
          pageCursor: "cursor_1",
        },
      },
      {
        path: "/v1/audits/audit_123/assets/code-changes",
        query: {
          search: "vanta",
          sourcesMatchesAny: ["github"],
          closedAfterDate: "2026-01-01T00:00:00Z",
          closedBeforeDate: "2026-12-31T23:59:59Z",
          pageSize: "50",
          pageCursor: "next-page",
        },
      },
    ]);
  });

  test("rejects an empty repository before requesting the Auditor API", async () => {
    let requested = false;
    const client: AuditorClient = {
      request: async () => {
        requested = true;
        throw new Error("The request should not run");
      },
    };

    await expect(
      listAuditCodeChanges(client, "audit_123", { sources: [], repository: "  " }),
    ).rejects.toThrow("--repository must not be empty.");
    expect(requested).toBe(false);
  });
});

describe("audit code-change CLI", () => {
  test("validates filters before Auditor API credentials", async () => {
    const invalidSource = await runCli([
      "audits",
      "code-changes",
      "list",
      "audit_123",
      "--source",
      "github-enterprise",
    ]);
    const invalidDate = await runCli([
      "audits",
      "code-changes",
      "list",
      "audit_123",
      "--closed-after",
      "tomorrow",
    ]);
    const invalidRepository = await runCli([
      "audits",
      "code-changes",
      "list",
      "audit_123",
      "--repository",
      "   ",
    ]);
    const invalidMaxPages = await runCli([
      "audits",
      "code-changes",
      "list",
      "audit_123",
      "--max-pages",
      "0",
    ]);

    expect(invalidSource.stderr).toContain("Invalid code-change source: github-enterprise");
    expect(invalidDate.stderr).toContain("--closed-after must be an RFC 3339 date-time");
    expect(invalidRepository.exitCode).toBe(1);
    expect(invalidRepository.stderr).toContain("--repository must not be empty.");
    expect(invalidRepository.stderr).not.toContain("Missing Vanta Auditor API credentials.");
    expect(invalidMaxPages.exitCode).toBe(1);
    expect(invalidMaxPages.stderr).toContain("--max-pages must be an integer from 1 to 100.");
  });

  test("reports dedicated Auditor API credentials", async () => {
    const result = await runCli(["audits", "code-changes", "list", "audit_123"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Missing Vanta Auditor API credentials.");
  });
});

async function runCli(args: string[]): Promise<{ exitCode: number; stderr: string }> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("VANTA_")),
  );
  delete env.VANTA_AUDITOR_CLIENT_ID;
  delete env.VANTA_AUDITOR_CLIENT_SECRET;
  env.VANTA_AUDITOR_TOKEN_CACHE_PATH = `/tmp/vanta-cli-missing-auditor-token-cache-${Date.now()}-${Math.random()}.json`;
  const proc = Bun.spawn(
    [
      "bun",
      "--no-env-file",
      "run",
      "src/vanta.ts",
      "--config",
      "/tmp/vanta-cli-missing-config.json",
      ...args,
    ],
    { cwd: import.meta.dir.replace(/\/test$/, ""), env, stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stderr] = await Promise.all([proc.exited, proc.stderr.text()]);
  return { exitCode, stderr };
}
