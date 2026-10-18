import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { batchResourceUpdates, planResourceChange } from "../src/integration-resources.ts";

const entrypoint = resolve(import.meta.dir, "../src/vanta.ts");

type SeenRequest = { method: string; pathname: string; search: string; body?: unknown };

const kind = {
  integrationId: "aws",
  resourceKind: "EC2Instance",
  isScopable: true,
  canUpdateOwner: true,
  canUpdateDescription: true,
  numResources: 3,
  numInScope: 2,
  numOwned: 0,
  numWithDescription: 0,
};

function resource(id: string, region: string, inScope: boolean, displayName = id) {
  return {
    responseType: "ComputeInstance",
    resourceKind: "EC2Instance",
    resourceId: id,
    connectionId: "conn-1",
    displayName,
    owner: null,
    inScope,
    description: null,
    creationDate: "2026-01-01T00:00:00.000Z",
    account: "111122223333",
    region,
  };
}

function page(data: ReturnType<typeof resource>[], cursor?: string) {
  return {
    results: {
      data,
      pageInfo: { hasNextPage: cursor !== undefined, endCursor: cursor ?? null },
    },
  };
}

async function fixture<T>(
  operation: (context: {
    requests: SeenRequest[];
    cli: (
      args: string[],
      options?: { stdin?: string },
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  }) => Promise<T>,
  respond: (request: Request, body: unknown) => Response | Promise<Response>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "vanta-resources-"));
  const requests: SeenRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body =
        request.method === "GET" || request.method === "HEAD" ? undefined : await request.json();
      if (url.pathname !== "/oauth/token") {
        requests.push({
          method: request.method,
          pathname: url.pathname,
          search: url.search,
          body,
        });
      }
      if (url.pathname === "/oauth/token") {
        return Response.json({ access_token: "fresh-synthetic-token", expires_in: 3600 });
      }
      return respond(request, body);
    },
  });
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VANTA_"))),
    VANTA_CLIENT_ID: "client-B",
    VANTA_CLIENT_SECRET: "synthetic-secret",
    VANTA_BASE_URL: server.url.origin,
    VANTA_TOKEN_CACHE_PATH: join(dir, "cache.json"),
    VANTA_PROFILES_DIR: join(dir, "profiles"),
    VANTA_CONFIG_PATH: join(dir, "missing.json"),
  };
  try {
    return await operation({
      requests,
      async cli(args, options = {}) {
        const child = Bun.spawn([process.execPath, entrypoint, ...args], {
          cwd: dir,
          env,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        child.stdin.write(options.stdin ?? "");
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

function assertNoSecrets(text: string): void {
  expect(text).not.toContain("synthetic-secret");
  expect(text).not.toContain("fresh-synthetic-token");
}

describe("integration resource planning", () => {
  test("skips a resource that already has the requested scope and batches by 50", () => {
    expect(
      planResourceChange(resource("i-1", "ap-south-1", false), { inScope: false }),
    ).toBeUndefined();
    expect(
      planResourceChange(resource("i-1", "ap-south-1", true), { inScope: false })?.update,
    ).toEqual({ id: "i-1", inScope: false });
    expect(
      batchResourceUpdates(Array.from({ length: 51 }, (_, index) => ({ id: String(index) }))),
    ).toEqual([Array.from({ length: 50 }, (_, index) => ({ id: String(index) })), [{ id: "50" }]]);
  });
});

describe("integrations update-resources", () => {
  test("dry-run lists every page and plans only the matching region", async () => {
    await fixture(
      async ({ cli, requests }) => {
        const result = await cli([
          "integrations",
          "update-resources",
          "aws",
          "EC2Instance",
          "--region",
          "ap-south-1",
          "--in-scope",
          "true",
          "--set-in-scope",
          "false",
          "--json",
        ]);
        expect(result.exitCode).toBe(0);
        assertNoSecrets(result.stdout + result.stderr);
        const output = JSON.parse(result.stdout);
        expect(output.dryRun).toBe(true);
        expect(output.requiresApply).toBe(true);
        expect(output.updates).toEqual([
          { id: "i-south-1", inScope: false },
          { id: "i-south-2", inScope: false },
        ]);
        expect(output.unchanged).toBe(0);
        expect(output.requests).toHaveLength(1);
        expect(output.requests[0].body.updates).toHaveLength(2);
        expect(requests.map((request) => request.method)).toEqual(["GET", "GET", "GET"]);
        expect(requests[0]?.pathname).toBe("/v1/integrations/aws/resource-kinds/EC2Instance");
        expect(requests[1]?.search).toContain("isInScope=true");
        expect(requests[2]?.search).toContain("pageCursor=cursor-2");
        expect(requests.some((request) => request.method === "PATCH")).toBe(false);
      },
      (request) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/resource-kinds/EC2Instance")) return Response.json(kind);
        if (url.searchParams.get("pageCursor") === "cursor-2") {
          return Response.json(page([resource("i-south-2", "ap-south-1", true, "web-2")]));
        }
        return Response.json(
          page(
            [
              resource("i-south-1", "ap-south-1", true, "web-1"),
              resource("i-east-1", "us-east-1", true, "web-east"),
            ],
            "cursor-2",
          ),
        );
      },
    );
  });

  test("apply lists again, confirms, and batches patches of 50", async () => {
    const ids = Array.from({ length: 51 }, (_, index) => `i-${index}`);
    await fixture(
      async ({ cli, requests }) => {
        const aborted = await cli(
          [
            "integrations",
            "update-resources",
            "aws",
            "EC2Instance",
            "--region",
            "ap-south-1",
            "--set-in-scope",
            "false",
            "--apply",
            "--json",
          ],
          { stdin: "" },
        );
        expect(aborted.exitCode).toBe(2);
        expect(aborted.stderr).toContain("no confirmation received");
        expect(aborted.stderr).toContain("web-0 (i-0)");
        expect(aborted.stderr).toContain("web-50 (i-50)");
        expect(requests.some((request) => request.method === "PATCH")).toBe(false);

        const applied = await cli(
          [
            "--apply",
            "--yes",
            "integrations",
            "update-resources",
            "aws",
            "EC2Instance",
            "--region",
            "ap-south-1",
            "--set-in-scope",
            "false",
            "--json",
          ],
          { stdin: "" },
        );
        expect(applied.exitCode).toBe(0);
        const output = JSON.parse(applied.stdout);
        expect(output.applied).toBe(true);
        expect(output.batches).toBe(2);
        expect(output.succeeded).toBe(51);
        const patches = requests.filter((request) => request.method === "PATCH");
        expect(patches).toHaveLength(2);
        const firstPatch = patches[0];
        const secondPatch = patches[1];
        if (!firstPatch || !secondPatch) throw new Error("expected two PATCH requests");
        expect((firstPatch.body as { updates: unknown[] }).updates).toHaveLength(50);
        expect((secondPatch.body as { updates: unknown[] }).updates).toHaveLength(1);
      },
      (request, body) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/resource-kinds/EC2Instance")) return Response.json(kind);
        if (request.method === "PATCH") {
          const updates = (body as { updates: { id: string }[] }).updates;
          return Response.json({
            results: updates.map((update) => ({ id: update.id, status: "SUCCESS" })),
          });
        }
        return Response.json(
          page(ids.map((id) => resource(id, "ap-south-1", true, id.replace("i-", "web-")))),
        );
      },
    );
  });

  test("skips resources that already match and filters display names locally", async () => {
    await fixture(
      async ({ cli, requests }) => {
        const result = await cli([
          "integrations",
          "update-resources",
          "aws",
          "EC2Instance",
          "--region",
          "ap-south-1",
          "--display-name",
          "^web-",
          "--set-in-scope",
          "false",
          "--json",
        ]);
        expect(result.exitCode).toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output.matched).toBe(2);
        expect(output.unchanged).toBe(1);
        expect(output.updates).toEqual([{ id: "i-web", inScope: false }]);
        expect(output.requiresApply).toBe(true);
        expect(requests.some((request) => request.method === "PATCH")).toBe(false);
      },
      (request) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/resource-kinds/EC2Instance")) return Response.json(kind);
        return Response.json(
          page([
            resource("i-web", "ap-south-1", true, "web-api"),
            resource("i-done", "ap-south-1", false, "web-done"),
            resource("i-other", "ap-south-1", true, "db-1"),
          ]),
        );
      },
    );
  });

  test("updates explicit ids without listing resources", async () => {
    await fixture(
      async ({ cli, requests }) => {
        const result = await cli([
          "--apply",
          "--yes",
          "integrations",
          "update-resources",
          "aws",
          "EC2Instance",
          "--id",
          "i-a",
          "--id",
          "i-b",
          "--owner-id",
          "person-1",
          "--description",
          "out of audit scope",
          "--json",
        ]);
        expect(result.exitCode).toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output.succeeded).toBe(2);
        expect(requests.map((request) => `${request.method} ${request.pathname}`)).toEqual([
          "GET /v1/integrations/aws/resource-kinds/EC2Instance",
          "PATCH /v1/integrations/aws/resource-kinds/EC2Instance/resources",
        ]);
        expect(requests[1]?.body).toEqual({
          updates: [
            { id: "i-a", ownerId: "person-1", description: "out of audit scope" },
            { id: "i-b", ownerId: "person-1", description: "out of audit scope" },
          ],
        });
      },
      (request, body) => {
        if (request.method === "GET") return Response.json(kind);
        const updates = (body as { updates: { id: string }[] }).updates;
        return Response.json({
          results: updates.map((update) => ({ id: update.id, status: "SUCCESS" })),
        });
      },
    );
  });

  test("refuses unsupported scope and owner updates before listing", async () => {
    await fixture(
      async ({ cli, requests }) => {
        const scope = await cli([
          "integrations",
          "update-resources",
          "aws",
          "EC2Instance",
          "--region",
          "ap-south-1",
          "--set-in-scope",
          "false",
          "--json",
        ]);
        expect(scope.exitCode).toBe(1);
        expect(JSON.parse(scope.stderr).error.message).toContain("not scopable");
        const owner = await cli([
          "integrations",
          "update-resources",
          "aws",
          "EC2Instance",
          "--id",
          "i-a",
          "--owner-id",
          "person-1",
          "--json",
        ]);
        expect(owner.exitCode).toBe(1);
        expect(JSON.parse(owner.stderr).error.message).toContain("does not allow owner updates");
        expect(requests.every((request) => request.method === "GET")).toBe(true);
        expect(requests.every((request) => request.pathname.endsWith("/EC2Instance"))).toBe(true);
      },
      () =>
        Response.json({
          ...kind,
          isScopable: false,
          canUpdateOwner: false,
          canUpdateDescription: false,
        }),
    );
  });

  test("reports per-entry failures and exits non-zero", async () => {
    await fixture(
      async ({ cli }) => {
        const result = await cli([
          "--apply",
          "--yes",
          "integrations",
          "update-resources",
          "aws",
          "EC2Instance",
          "--id",
          "i-ok",
          "--id",
          "i-bad",
          "--set-in-scope",
          "false",
          "--json",
        ]);
        expect(result.exitCode).toBe(1);
        const output = JSON.parse(result.stdout);
        expect(output.succeeded).toBe(1);
        expect(output.failed).toBe(1);
        expect(output.results[1]).toMatchObject({ id: "i-bad", status: "ERROR" });
        assertNoSecrets(result.stdout + result.stderr);
      },
      (request) => {
        if (request.method === "GET") return Response.json(kind);
        return Response.json({
          results: [
            { id: "i-ok", status: "SUCCESS" },
            { id: "i-bad", status: "ERROR", message: "resource not found" },
          ],
        });
      },
    );
  });

  test("shows resource kind counts", async () => {
    await fixture(
      async ({ cli, requests }) => {
        const result = await cli([
          "integrations",
          "resource-kind",
          "aws",
          "EC2Instance",
          "--connection-id",
          "conn-1",
          "--json",
        ]);
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          resourceKind: "EC2Instance",
          numInScope: 2,
          isScopable: true,
        });
        expect(requests[0]?.pathname).toBe("/v1/integrations/aws/resource-kinds/EC2Instance");
        expect(requests[0]?.search).toContain("connectionId=conn-1");
      },
      () => Response.json(kind),
    );
  });
});
