import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entrypoint = resolve(import.meta.dir, "../src/vanta.ts");
const startDate = "2026-01-01T00:00:00Z";
const endDate = "2026-03-01T00:00:00Z";
const person = {
  id: "p-1",
  name: { display: "Person One" },
  employment: { status: "FORMER", startDate, endDate },
  tasksSummary: {
    details: {
      completeOffboardingCustomTasks: {
        status: "COMPLETE",
        incompleteCustomOffboardingTasks: [],
      },
    },
  },
};
const acknowledger = { id: "a-1", name: { display: "Acknowledger One" } };
const updateArgs = ["personnel", "update", "p-1", "--first-name", "New", "--last-name", "Name"];
const leaveArgs = ["personnel", "set-leave", "p-1", "--start-date", startDate, "--indefinite"];
const clearArgs = ["personnel", "clear-leave", "p-1"];
const offboardArgs = ["personnel", "offboard", "p-1", "--acknowledger-id", "a-1"];

type SeenRequest = { method: string; path: string; query: URLSearchParams; body: unknown };

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
      ? Response.json(request.path.endsWith("/a-1") ? acknowledger : person)
      : Response.json(
          request.path === "/v1/people/offboard"
            ? { results: [{ id: "p-1", status: "SUCCESS" }] }
            : person,
        ),
) {
  const dir = mkdtempSync(join(tmpdir(), "vanta-personnel-"));
  const requests: SeenRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const seen: SeenRequest = {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        body: undefined,
      };
      const text = request.method === "GET" ? "" : await request.text();
      seen.body = text ? JSON.parse(text) : undefined;
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

describe("personnel mutation CLI", () => {
  test("help exposes the personnel mutation options without network requests", async () => {
    await fixture(async ({ cli, requests }) => {
      const root = await cli(["personnel", "--help"]);
      expect(root.exitCode).toBe(0);
      for (const command of ["update", "set-leave", "clear-leave", "offboard"])
        expect(root.stdout).toContain(command);
      const help = await cli(["personnel", "offboard", "--help"]);
      expect(help.stdout).toContain("--acknowledger-id");
      expect(help.stdout).toContain("unmonitored accounts");
      expect(requests).toEqual([]);
    });
  });

  test("dry-runs all personnel mutations offline, including offboarding", async () => {
    await fixture(async ({ cli, requests }) => {
      for (const args of [updateArgs, leaveArgs, clearArgs, offboardArgs]) {
        const result = await cli(args);
        expect(result.exitCode).toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output).toMatchObject({ dryRun: true, mutation: true, requiresApply: true });
        expect(output.guidance).toContain("apply time");
      }
      expect(requests).toEqual([]);
    });
  });

  test("rejects unsupported fields, partial names, empty updates and invalid dates without requests", async () => {
    await fixture(async ({ cli, requests }) => {
      for (const args of [
        ["personnel", "update", "p-1"],
        ["personnel", "update", "p-1", "--first-name", "New"],
        ["personnel", "update", "p-1", "--last-name", "New"],
        ["personnel", "update", "p-1", "--first-name", " ", "--last-name", "New"],
        ["personnel", "update", "p-1", "--job-title", "Engineer"],
        ["personnel", "update", "p-1", "--employment-status", "FORMER"],
        ["personnel", "update", "p-1", "--employment-start-date", "2026-01-01"],
        ["personnel", "update", "p-1", "--employment-start-date", "2026-02-30T00:00:00Z"],
        ["personnel", "set-leave", "p-1", "--start-date", startDate],
        [...leaveArgs, "--end-date", endDate],
        ["personnel", "set-leave", "p-1", "--start-date", endDate, "--end-date", startDate],
        ["personnel", "set-leave", "p-1", "--start-date", "2026-01-01", "--indefinite"],
        ["personnel", "set-leave", "p-1", "--start-date", startDate, "--end-date", "bad"],
        ["personnel", "offboard", "p-1"],
        [...offboardArgs.slice(0, 4), " "],
      ]) {
        const result = await cli([...args, "--apply", "--yes"]);
        expect(result.exitCode).not.toBe(0);
      }
      expect(requests).toEqual([]);
    });
  });

  test("PATCH sends only paired name fields and employment start; original reads remain available", async () => {
    await fixture(async ({ cli, requests }) => {
      for (const args of [
        [...updateArgs, "--employment-start-date", startDate],
        ["personnel", "update", "p-1", "--employment-start-date", startDate],
      ])
        expect((await cli([...args, "--apply", "--yes"])).exitCode).toBe(0);
      expect(apiRequests(requests).map((r) => [r.method, r.path])).toEqual([
        ["GET", "/v1/people/p-1"],
        ["PATCH", "/v1/people/p-1"],
        ["GET", "/v1/people/p-1"],
        ["PATCH", "/v1/people/p-1"],
      ]);
      expect(apiRequests(requests)[1]?.body).toEqual({
        name: { first: "New", last: "Name" },
        employment: { startDate },
      });
      expect(apiRequests(requests)[3]?.body).toEqual({ employment: { startDate } });
      expect((await cli(["personnel", "list", "--query", "pageSize=5"])).exitCode).toBe(0);
      expect((await cli(["personnel", "get", "p-1"])).exitCode).toBe(0);
      expect(
        apiRequests(requests)
          .slice(-2)
          .map((r) => r.path),
      ).toEqual(["/v1/people", "/v1/people/p-1"]);
    });
  });

  test("set-leave distinguishes explicit null from bounded leave; clear-leave sends no body", async () => {
    await fixture(async ({ cli, requests }) => {
      for (const args of [
        leaveArgs,
        ["personnel", "set-leave", "p-1", "--start-date", startDate, "--end-date", endDate],
        clearArgs,
      ])
        expect((await cli([...args, "--apply", "--yes"])).exitCode).toBe(0);
      const writes = apiRequests(requests).filter((r) => r.method !== "GET");
      expect(writes.map((r) => [r.path, r.body])).toEqual([
        ["/v1/people/p-1/set-leave", { startDate, endDate: null }],
        ["/v1/people/p-1/set-leave", { startDate, endDate }],
        ["/v1/people/p-1/clear-leave", undefined],
      ]);
      expect(apiRequests(requests).map((r) => r.method)).toEqual([
        "GET",
        "POST",
        "GET",
        "POST",
        "GET",
        "POST",
      ]);
    });
  });

  test("encodes person IDs for apply-time read and mutation", async () => {
    const id = "p/1 ?";
    await fixture(
      async ({ cli, requests }) => {
        const result = await cli(["personnel", "clear-leave", id, "--apply", "--yes"]);
        expect(result.exitCode).toBe(0);
        expect(apiRequests(requests).map((r) => r.path)).toEqual([
          `/v1/people/${encodeURIComponent(id)}`,
          `/v1/people/${encodeURIComponent(id)}/clear-leave`,
        ]);
      },
      () => Response.json({ ...person, id }),
    );
  });

  test("requires confirmation for each mutation and shows target identity", async () => {
    await fixture(async ({ cli, requests }) => {
      for (const args of [updateArgs, leaveArgs, clearArgs, offboardArgs]) {
        const result = await cli([...args, "--apply"], "no\n");
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("Person One");
        if (args === offboardArgs) {
          expect(result.stderr).toContain("Acknowledger One");
          expect(result.stderr).toContain("FORMER");
          expect(result.stderr).toContain("COMPLETE");
          expect(result.stderr).toContain("Monitored-account eligibility is not fully exposed");
        }
      }
      expect(apiRequests(requests).every((r) => r.method === "GET")).toBe(true);
    });
  });

  test("offboarding sends one matching update after reading both identities and exposes observations", async () => {
    await fixture(async ({ cli, requests }) => {
      const result = await cli([...offboardArgs, "--apply"], "yes\n");
      expect(result.exitCode).toBe(0);
      expect(apiRequests(requests).map((r) => [r.method, r.path])).toEqual([
        ["GET", "/v1/people/p-1"],
        ["GET", "/v1/people/a-1"],
        ["POST", "/v1/people/offboard"],
      ]);
      expect(apiRequests(requests)[2]?.body).toEqual({
        updates: [{ id: "p-1", acknowledgerId: "a-1" }],
      });
      expect(JSON.parse(result.stdout)).toMatchObject({
        accepted: true,
        result: { id: "p-1", status: "SUCCESS" },
        observations: {
          target: { id: "p-1" },
          acknowledger: { id: "a-1" },
          employment: { status: "FORMER" },
        },
      });
      expect(result.stderr).toContain("External accounts are not disconnected");
    });
  });

  test.each(["CURRENT", "UPCOMING", "ON_LEAVE"])(
    "blocks observed %s employment without writes",
    async (status) => {
      await fixture(
        async ({ cli, requests }) => {
          expect((await cli([...offboardArgs, "--apply", "--yes"])).exitCode).not.toBe(0);
          expect(apiRequests(requests).every((r) => r.method === "GET")).toBe(true);
        },
        () => Response.json({ ...person, employment: { ...person.employment, status } }),
      );
    },
  );

  test.each([
    { status: "OVERDUE", incompleteCustomOffboardingTasks: [] },
    { status: "DUE_SOON", incompleteCustomOffboardingTasks: [] },
    { status: "COMPLETE", incompleteCustomOffboardingTasks: [{ name: "Return laptop" }] },
    { status: "UNKNOWN", incompleteCustomOffboardingTasks: [] },
    {},
  ])("blocks unfinished or unobservable custom tasks %#", async (tasks) => {
    await fixture(
      async ({ cli, requests }) => {
        expect((await cli([...offboardArgs, "--apply", "--yes"])).exitCode).not.toBe(0);
        expect(apiRequests(requests).every((r) => r.method === "GET")).toBe(true);
      },
      () =>
        Response.json({
          ...person,
          tasksSummary: { details: { completeOffboardingCustomTasks: tasks } },
        }),
    );
  });

  test.each(["p-1", "a-1"])("missing or mismatched %s blocks offboarding", async (id) => {
    for (const missing of [true, false])
      await fixture(
        async ({ cli, requests }) => {
          const result = await cli([...offboardArgs, "--apply", "--yes"]);
          expect(result.exitCode).not.toBe(0);
          expect(apiRequests(requests).every((r) => r.method === "GET")).toBe(true);
        },
        (request) =>
          request.path.endsWith(`/${id}`)
            ? missing
              ? Response.json({ message: "not found" }, { status: 404 })
              : Response.json({ ...person, id: "wrong" })
            : Response.json(person),
      );
  });

  test("INACTIVE and unassigned tasks remain observations, with Vanta checking server-only eligibility", async () => {
    await fixture(
      async ({ cli, requests }) => {
        const result = await cli([...offboardArgs, "--apply", "--yes"]);
        expect(result.exitCode).not.toBe(0);
        expect(JSON.parse(result.stderr).error.type).toBe("BulkUpdateError");
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toContain("synthetic-secret");
        expect(apiRequests(requests).at(-1)?.method).toBe("POST");
      },
      (request) =>
        request.method === "GET"
          ? Response.json(
              request.path.endsWith("/a-1")
                ? acknowledger
                : {
                    ...person,
                    employment: { ...person.employment, status: "INACTIVE" },
                    tasksSummary: {
                      details: {
                        completeOffboardingCustomTasks: {
                          status: "NONE",
                          incompleteCustomOffboardingTasks: [],
                        },
                      },
                    },
                  },
            )
          : Response.json({
              results: [
                { id: "p-1", status: "ERROR", message: "Account still active synthetic-secret" },
              ],
            }),
    );
  });

  test.each([
    { results: [] },
    { results: [{ id: "other", status: "SUCCESS" }] },
    {
      results: [
        { id: "p-1", status: "SUCCESS" },
        { id: "p-1", status: "SUCCESS" },
      ],
    },
    { results: [{ id: "p-1", status: "UNKNOWN" }] },
  ])("rejects malformed offboarding success %#", async (response) => {
    await fixture(
      async ({ cli }) => {
        const result = await cli([...offboardArgs, "--apply", "--yes"]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toBe("");
      },
      (request) =>
        request.method === "GET"
          ? Response.json(request.path.endsWith("/a-1") ? acknowledger : person)
          : Response.json(response),
    );
  });

  test("mismatched target blocks ordinary changes before writing", async () => {
    await fixture(
      async ({ cli, requests }) => {
        for (const args of [updateArgs, leaveArgs, clearArgs])
          expect((await cli([...args, "--apply", "--yes"])).exitCode).not.toBe(0);
        expect(apiRequests(requests).every((r) => r.method === "GET")).toBe(true);
      },
      () => Response.json({ ...person, id: "wrong" }),
    );
  });
});
