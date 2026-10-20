import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { assertSingleTargetBulkResult } from "../src/bulk-result.ts";

const entrypoint = resolve(import.meta.dir, "../src/vanta.ts");
const expiry = "2099-12-31T23:59:59Z";
const metadata = {
  isVulnDeactivatedIndefinitely: true,
  deactivatedUntilDate: null,
  deactivationReason: "accepted risk",
  deactivatedOnDate: "2026-01-01T00:00:00Z",
  deactivatedBy: "user-1",
};
const vulnerability = { id: "v-1", name: "CVE fixture", deactivateMetadata: null };
const deactivateArgs = [
  "vulnerabilities",
  "deactivate",
  "v-1",
  "--reason",
  "accepted risk",
  "--reactivate-when-fixable",
  "false",
];
const reactivateArgs = ["vulnerabilities", "reactivate", "v-1"];
const acknowledgeArgs = [
  "vulnerabilities",
  "remediations",
  "acknowledge-sla-miss",
  "r-1",
  "--comment",
  "dependency release delayed",
];

type SeenRequest = { method: string; path: string; query: URLSearchParams; body: unknown };

function page(data: unknown[], cursor?: string) {
  return {
    results: { data, pageInfo: { hasNextPage: cursor !== undefined, endCursor: cursor ?? null } },
  };
}

async function fixture(
  operation: (context: {
    requests: SeenRequest[];
    cli: (
      args: string[],
      stdin?: string,
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  }) => Promise<void>,
  respond: (request: SeenRequest) => Response = (request) =>
    request.method === "GET"
      ? Response.json(vulnerability)
      : Response.json({ results: [{ id: "v-1", status: "SUCCESS" }] }),
) {
  const dir = mkdtempSync(join(tmpdir(), "vanta-vulnerabilities-"));
  const requests: SeenRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const seen = {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        body: request.method === "GET" ? undefined : await request.json(),
      };
      requests.push(seen);
      if (url.pathname === "/oauth/token") {
        return Response.json({ access_token: "synthetic-token", expires_in: 3600 });
      }
      return respond(seen);
    },
  });
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VANTA_"))),
    VANTA_CLIENT_ID: "synthetic-client",
    VANTA_CLIENT_SECRET: "synthetic-secret",
    VANTA_BASE_URL: server.url.origin,
    VANTA_CONFIG_PATH: join(dir, "missing.json"),
    VANTA_PROFILES_DIR: join(dir, "profiles"),
    VANTA_TOKEN_CACHE_PATH: join(dir, "cache.json"),
  };
  try {
    await operation({
      requests,
      async cli(args, stdin = "") {
        const child = Bun.spawn([process.execPath, entrypoint, ...args, "--json"], {
          cwd: resolve(import.meta.dir, ".."),
          env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        child.stdin.write(stdin);
        child.stdin.end();
        const timeout = setTimeout(() => child.kill(), 5000);
        try {
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            child.stdout.text(),
            child.stderr.text(),
          ]);
          return { exitCode, stdout, stderr };
        } finally {
          clearTimeout(timeout);
        }
      },
    });
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

function apiRequests(requests: SeenRequest[]) {
  return requests.filter((request) => request.path !== "/oauth/token");
}

describe("single-target BulkResponse", () => {
  test("accepts only the matching success result", () => {
    expect(
      assertSingleTargetBulkResult({ results: [{ id: "one", status: "SUCCESS" }] }, "one"),
    ).toEqual({ id: "one", status: "SUCCESS" });
  });

  test.each([
    undefined,
    {},
    { results: [] },
    {
      results: [
        { id: "one", status: "SUCCESS" },
        { id: "one", status: "SUCCESS" },
      ],
    },
    {
      results: [
        { id: "one", status: "SUCCESS" },
        { id: "two", status: "SUCCESS" },
      ],
    },
    { results: [{ id: "two", status: "SUCCESS" }] },
    { results: [{ id: "one", status: "UNKNOWN" }] },
    { results: [{ id: "one", status: "ERROR" }] },
    { results: [{ id: "one", status: "ERROR", message: 123 }] },
    { results: [null] },
  ])("rejects malformed or mismatched result %#", (response) => {
    expect(() => assertSingleTargetBulkResult(response, "one")).toThrow();
  });
});

describe("vulnerability mutation CLI", () => {
  test("dry-runs all mutations without token or API requests", async () => {
    await fixture(async ({ cli, requests }) => {
      for (const args of [deactivateArgs, reactivateArgs, acknowledgeArgs]) {
        const result = await cli(args);
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).dryRun).toBe(true);
      }
      expect(requests).toEqual([]);
    });
  });

  test("requires reason, comment, an explicit boolean and a valid future expiry before requests", async () => {
    await fixture(async ({ cli, requests }) => {
      const invalidArgs = [
        ["vulnerabilities", "deactivate", "v-1", "--reason", "x"],
        ["vulnerabilities", "deactivate", "v-1", "--reactivate-when-fixable", "true"],
        [
          "vulnerabilities",
          "deactivate",
          "v-1",
          "--reason",
          " ",
          "--reactivate-when-fixable",
          "true",
        ],
        [
          "vulnerabilities",
          "deactivate",
          "v-1",
          "--reason",
          "x",
          "--reactivate-when-fixable",
          "maybe",
        ],
        [...deactivateArgs, "--until", "2000-01-01T00:00:00Z"],
        [...deactivateArgs, "--until", "2099-02-30T00:00:00Z"],
        [...deactivateArgs, "--until", "2099-12-31"],
        [...deactivateArgs, "--until", "2099-12-31T23:59Z"],
        ["vulnerabilities", "remediations", "acknowledge-sla-miss", "r-1", "--comment", " "],
        ["vulnerabilities", "remediations", "acknowledge-sla-miss", "r-1"],
      ];
      for (const args of invalidArgs) {
        const result = await cli([...args, "--apply", "--yes"]);
        expect(result.exitCode).not.toBe(0);
        expect(JSON.parse(result.stderr).ok).toBe(false);
      }
      expect(requests).toEqual([]);
    });
  });

  test.each(["true", "false"])(
    "sends one deactivation update with explicit policy %s and expiry",
    async (policy) => {
      await fixture(async ({ cli, requests }) => {
        const result = await cli([
          "vulnerabilities",
          "deactivate",
          "v-1",
          "--reason",
          " accepted risk ",
          "--reactivate-when-fixable",
          policy,
          "--until",
          expiry,
          "--apply",
          "--yes",
        ]);
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          accepted: true,
          result: { id: "v-1", status: "SUCCESS" },
        });
        expect(apiRequests(requests).map((r) => [r.method, r.path])).toEqual([
          ["GET", "/v1/vulnerabilities/v-1"],
          ["POST", "/v1/vulnerabilities/deactivate"],
        ]);
        expect(apiRequests(requests)[1]?.body).toEqual({
          updates: [
            {
              id: "v-1",
              deactivateReason: "accepted risk",
              shouldReactivateWhenFixable: policy === "true",
              deactivateUntilDate: expiry,
            },
          ],
        });
      });
    },
  );

  test("omits expiry without claiming an indefinite exception and does not skip policy changes", async () => {
    await fixture(
      async ({ cli, requests }) => {
        const dryRun = await cli(deactivateArgs);
        expect(JSON.parse(dryRun.stdout).summary).toContain("omitted from request");
        const result = await cli([...deactivateArgs, "--apply", "--yes"]);
        expect(result.exitCode).toBe(0);
        expect(apiRequests(requests)[1]?.body).toEqual({
          updates: [
            { id: "v-1", deactivateReason: "accepted risk", shouldReactivateWhenFixable: false },
          ],
        });
      },
      (request) =>
        request.method === "GET"
          ? Response.json({ ...vulnerability, deactivateMetadata: metadata })
          : Response.json({ results: [{ id: "v-1", status: "SUCCESS" }] }),
    );
  });

  test("reactivation skips explicitly active state", async () => {
    await fixture(async ({ cli, requests }) => {
      const result = await cli([...reactivateArgs, "--apply", "--yes"]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        noChange: true,
        id: "v-1",
        reason: "Already active.",
      });
      expect(apiRequests(requests).map((r) => r.method)).toEqual(["GET"]);
    });
  });

  test("reactivation reads the encoded target and sends the explicit ID", async () => {
    const id = "v/1 ?";
    await fixture(
      async ({ cli, requests }) => {
        const result = await cli(["vulnerabilities", "reactivate", id, "--apply", "--yes"]);
        expect(result.exitCode).toBe(0);
        expect(apiRequests(requests)[0]?.path).toBe(
          `/v1/vulnerabilities/${encodeURIComponent(id)}`,
        );
        expect(apiRequests(requests)[1]?.body).toEqual({ updates: [{ id }] });
      },
      (request) =>
        request.method === "GET"
          ? Response.json({ ...vulnerability, id, deactivateMetadata: metadata })
          : Response.json({ results: [{ id, status: "SUCCESS" }] }),
    );
  });

  test.each([
    { id: "other", name: "wrong", deactivateMetadata: null },
    { id: "v-1", name: "missing state" },
    { ...vulnerability, deactivateMetadata: {} },
    { ...vulnerability, deactivateMetadata: { ...metadata, deactivatedUntilDate: expiry } },
    { ...vulnerability, deactivateMetadata: { ...metadata, isVulnDeactivatedIndefinitely: false } },
    {
      ...vulnerability,
      deactivateMetadata: {
        ...metadata,
        isVulnDeactivatedIndefinitely: false,
        deactivatedUntilDate: "2000-01-01T00:00:00Z",
      },
    },
  ])("rejects missing, mismatched or contradictory apply-time metadata %#", async (state) => {
    await fixture(
      async ({ cli, requests }) => {
        const result = await cli([...deactivateArgs, "--apply", "--yes"]);
        expect(result.exitCode).not.toBe(0);
        expect(apiRequests(requests).map((r) => r.method)).toEqual(["GET"]);
      },
      () => Response.json(state),
    );
  });

  test("missing vulnerability stops before mutation", async () => {
    await fixture(
      async ({ cli, requests }) => {
        const result = await cli([...deactivateArgs, "--apply", "--yes"]);
        expect(result.exitCode).not.toBe(0);
        expect(JSON.parse(result.stderr).error.status).toBe(404);
        expect(apiRequests(requests).map((r) => r.method)).toEqual(["GET"]);
      },
      () => Response.json({ message: "not found" }, { status: 404 }),
    );
  });

  test("requires confirmation after showing the apply-time target", async () => {
    await fixture(async ({ cli, requests }) => {
      const result = await cli([...deactivateArgs, "--apply"], "no\n");
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("CVE fixture");
      expect(apiRequests(requests).map((r) => r.method)).toEqual(["GET"]);
    });
  });

  test("HTTP 200 per-entry error exits nonzero with redacted structured evidence", async () => {
    await fixture(
      async ({ cli }) => {
        const result = await cli([...deactivateArgs, "--apply", "--yes"]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toBe("");
        expect(JSON.parse(result.stderr)).toMatchObject({
          ok: false,
          error: { type: "BulkUpdateError" },
        });
        expect(result.stderr).toContain("v-1");
        expect(result.stderr).toContain("ERROR");
        expect(result.stderr).not.toContain("synthetic-secret");
        expect(result.stderr).not.toContain("synthetic-token");
      },
      (request) =>
        request.method === "GET"
          ? Response.json(vulnerability)
          : Response.json({
              results: [
                { id: "v-1", status: "ERROR", message: "synthetic-secret synthetic-token" },
              ],
            }),
    );
  });

  test("malformed success response cannot produce accepted output", async () => {
    await fixture(
      async ({ cli }) => {
        const result = await cli([...deactivateArgs, "--apply", "--yes"]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toBe("");
        expect(JSON.parse(result.stderr).ok).toBe(false);
      },
      (request) =>
        request.method === "GET" ? Response.json(vulnerability) : Response.json({ results: [] }),
    );
  });
});

describe("vulnerability read and remediation CLI", () => {
  test("preserves original vulnerability list/get and maps asset and remediation reads", async () => {
    await fixture(
      async ({ cli, requests }) => {
        for (const args of [
          ["vulnerabilities", "list", "--query", "severity=HIGH"],
          ["vulnerabilities", "get", "v-1"],
          ["vulnerabilities", "assets", "get", "asset/one"],
          ["vulnerabilities", "remediations", "list", "--query", "severity=LOW"],
        ])
          expect((await cli(args)).exitCode).toBe(0);
        expect(apiRequests(requests).map((r) => r.path)).toEqual([
          "/v1/vulnerabilities",
          "/v1/vulnerabilities/v-1",
          "/v1/vulnerable-assets/asset%2Fone",
          "/v1/vulnerability-remediations",
        ]);
      },
      () => Response.json(page([])),
    );
  });

  test.each(["assets", "remediations"])(
    "bounds %s list pages and preserves repeated filters",
    async (collection) => {
      await fixture(
        async ({ cli, requests }) => {
          const result = await cli([
            "vulnerabilities",
            collection,
            "list",
            "--all",
            "--query",
            "integrationId=a",
            "--query",
            "integrationId=b",
          ]);
          expect(result.exitCode).toBe(0);
          expect(JSON.parse(result.stdout).results.data).toEqual([
            { id: "first" },
            { id: "second" },
          ]);
          expect(apiRequests(requests).map((r) => r.query.getAll("integrationId"))).toEqual([
            ["a", "b"],
            ["a", "b"],
          ]);
        },
        (request) =>
          Response.json(
            request.query.has("pageCursor")
              ? page([{ id: "second" }])
              : page([{ id: "first" }], "next"),
          ),
      );
    },
  );

  test("acknowledgement scans filtered pages until the target and checks its bulk result", async () => {
    await fixture(
      async ({ cli, requests }) => {
        const result = await cli([
          ...acknowledgeArgs,
          "--query",
          "severity=HIGH",
          "--max-pages",
          "2",
          "--apply",
          "--yes",
        ]);
        expect(result.exitCode).toBe(0);
        expect(apiRequests(requests).map((r) => [r.method, r.path])).toEqual([
          ["GET", "/v1/vulnerability-remediations"],
          ["GET", "/v1/vulnerability-remediations"],
          ["POST", "/v1/vulnerability-remediations/acknowledge-sla-miss"],
        ]);
        expect(
          apiRequests(requests)
            .slice(0, 2)
            .map((r) => r.query.get("severity")),
        ).toEqual(["HIGH", "HIGH"]);
        expect(apiRequests(requests)[2]?.body).toEqual({
          updates: [{ id: "r-1", slaViolationComment: "dependency release delayed" }],
        });
      },
      (request) =>
        request.method === "POST"
          ? Response.json({ results: [{ id: "r-1", status: "SUCCESS" }] })
          : Response.json(
              request.query.has("pageCursor")
                ? page([{ id: "r-1" }], "third")
                : page([{ id: "other" }], "next"),
            ),
    );
  });

  test("acknowledgement distinguishes exhausted bounds from a completed scan without a match", async () => {
    for (const hasNextPage of [true, false]) {
      await fixture(
        async ({ cli, requests }) => {
          const result = await cli([...acknowledgeArgs, "--max-pages", "1", "--apply", "--yes"]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain(hasNextPage ? "safety limit" : "scan completed");
          expect(apiRequests(requests).map((r) => r.method)).toEqual(["GET"]);
        },
        () => Response.json(page([{ id: "other" }], hasNextPage ? "next" : undefined)),
      );
    }
  });

  test("acknowledgement rejects malformed or repeated pagination and unsupported lookup filters", async () => {
    for (const response of [
      {},
      { results: { data: [], pageInfo: { hasNextPage: "true" } } },
      page([], "same"),
    ]) {
      await fixture(
        async ({ cli, requests }) => {
          const result = await cli([
            ...acknowledgeArgs,
            "--query",
            "pageCursor=same",
            "--apply",
            "--yes",
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(apiRequests(requests).map((r) => r.method)).toEqual(["GET"]);
        },
        () => Response.json(response),
      );
    }
    await fixture(async ({ cli, requests }) => {
      const result = await cli([...acknowledgeArgs, "--query", "id=r-1", "--apply", "--yes"]);
      expect(result.exitCode).not.toBe(0);
      expect(requests).toEqual([]);
    });
  });

  test("Vanta remains authoritative for SLA acknowledgement eligibility", async () => {
    await fixture(
      async ({ cli, requests }) => {
        const result = await cli([...acknowledgeArgs, "--apply", "--yes"]);
        expect(result.exitCode).not.toBe(0);
        expect(JSON.parse(result.stderr).error.type).toBe("BulkUpdateError");
        expect(apiRequests(requests).map((r) => r.method)).toEqual(["GET", "POST"]);
      },
      (request) =>
        request.method === "GET"
          ? Response.json(page([{ id: "r-1" }]))
          : Response.json({ results: [{ id: "r-1", status: "ERROR", message: "not eligible" }] }),
    );
  });
});
