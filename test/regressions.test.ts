import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { TokenManager } from "../src/auth.ts";
import { VantaClient } from "../src/api.ts";
import { loadAuditorConfig, loadConfig, saveProfile } from "../src/config.ts";
import { formatJsonError, VantaApiError } from "../src/errors.ts";
import { requestAll } from "../src/pagination.ts";

const entrypoint = resolve(import.meta.dir, "../src/vanta.ts");

async function fixture<T>(
  operation: (context: {
    dir: string;
    config: ReturnType<typeof loadConfig>;
    requests: string[];
    cli: (
      args: string[],
      options?: { stdin?: string; env?: Record<string, string> },
    ) => Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>;
  }) => Promise<T>,
  respond: (request: Request) => Response | Promise<Response> = () =>
    new Response(null, { status: 204 }),
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "vanta-regression-"));
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(request.url);
      return new URL(request.url).pathname === "/oauth/token"
        ? Response.json({ access_token: "fresh-synthetic-token", expires_in: 3600 })
        : respond(request);
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
  const config = loadConfig({ env });
  try {
    return await operation({
      dir,
      config,
      requests,
      async cli(args, options = {}) {
        const child = Bun.spawn([process.execPath, entrypoint, ...args], {
          cwd: dir,
          env: { ...env, ...options.env },
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

describe("credential isolation", () => {
  test.each([undefined, "client-A"])("refreshes a cache bound to %s", async (clientId) => {
    await fixture(async ({ config, requests }) => {
      const manager = new TokenManager({
        config,
        readCache: () => ({
          accessToken: "old-tenant-token",
          clientId,
          baseUrl: config.baseUrl,
          scope: config.scope,
          expiresAt: Date.now() + 3_600_000,
        }),
      });
      expect(manager.status().cacheUsable).toBe(false);
      expect(await manager.getToken()).toBe("fresh-synthetic-token");
      expect(requests).toHaveLength(1);
      const cache = await Bun.file(config.tokenCachePath).json();
      expect(cache.clientId).toBe("client-B");
    });
  });

  test("rejects missing profiles and both kinds of ambient credentials", async () => {
    await fixture(async ({ dir }) => {
      const env = { VANTA_PROFILES_DIR: join(dir, "profiles") };
      expect(() => loadConfig({ env, profile: "missing" })).toThrow("No profile found");
      saveProfile("tenant", { clientId: "stored", clientSecret: "stored" }, { env });
      for (const key of [
        "VANTA_CLIENT_ID",
        "VANTA_CLIENT_SECRET",
        "VANTA_AUDITOR_CLIENT_ID",
        "VANTA_AUDITOR_CLIENT_SECRET",
      ]) {
        expect(() => loadConfig({ profile: "tenant", env: { ...env, [key]: "ambient" } })).toThrow(
          "cannot be combined",
        );
        expect(() =>
          loadAuditorConfig({ profile: "tenant", env: { ...env, [key]: "ambient" } }),
        ).toThrow("cannot be combined");
      }
    });
  });
});

describe("CLI output contract", () => {
  test.each(["controls", "documents"])(
    "%s set-owner sends Vanta's userId field",
    async (resource) => {
      await fixture(async ({ cli, requests }) => {
        const result = await cli([
          resource,
          "set-owner",
          "resource-id",
          "--owner-id",
          "person-id",
          "--json",
        ]);
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).request.body).toEqual({ userId: "person-id" });
        expect(requests).toHaveLength(0);
      });
    },
  );
  test.each(
    [
      ["vendors", "create"],
      ["vendors", "create", "--body", "{"],
      ["vendors", "create", "--body-file", "/missing-review-body.json"],
      ["raw", "PATCH", "/v1/vendors/id", "--body", "{"],
      ["vendors", "list", "--unknown"],
      ["unknown-command"],
      ["tests", "get"],
      ["documents", "download", "doc", "upload"],
      ["frameworks", "list", "--timeout-ms", "0"],
    ].map((args) => ({ args })),
  )("formats errors for %j", async ({ args }) => {
    await fixture(async ({ cli, requests }) => {
      const result = await cli([...args, "--json"]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({
        ok: false,
        error: { message: expect.any(String) },
      });
      expect(result.stderr).not.toContain("at /Users/");
      expect(requests).toHaveLength(0);
    });
  });

  test("serializes empty success and handles empty API errors", async () => {
    await fixture(async ({ cli }) => {
      const result = await cli(["raw", "GET", "/v1/empty", "--json"]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toBeNull();
    });
    expect(formatJsonError(new VantaApiError(401, undefined))).toMatchObject({
      ok: false,
      error: { status: 401, guidance: expect.any(String) },
    });
  });

  test("JSON debug errors remain one document", async () => {
    await fixture(async ({ cli }) => {
      const result = await cli(["vendors", "create", "--json", "--debug"]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr).error.stack).toContain("parseRequiredBodyInput");
    });
  });

  test("confirmation aborts on EOF", async () => {
    await fixture(async ({ cli, requests }) => {
      const result = await cli(["controls", "deactivate", "id", "--apply"], { stdin: "" });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("no confirmation received");
      expect(requests).toHaveLength(0);
    });
  });

  test("help and version succeed outside the checkout", async () => {
    await fixture(async ({ cli, requests }) => {
      const version = await cli(["--version"]);
      const help = await cli(["--help"]);
      expect(version.exitCode).toBe(0);
      expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain("--timeout-ms");
      const incomplete = await cli(["documents"]);
      expect(incomplete.stderr).toContain("Usage:");
      expect(requests).toHaveLength(0);
    });
  });
});

describe("piped credentials", () => {
  test.each(["secret-without-newline", "secret-with-newline\n"])("accepts %j", async (stdin) => {
    await fixture(async ({ cli }) => {
      const result = await cli(["auth", "profile", "add", "--name", "new", "--json"], {
        stdin,
        env: { VANTA_CLIENT_SECRET: "" },
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).saved).toBe(true);
      expect(result.stdout).not.toContain(stdin.trim());
    });
  });

  test("rejects empty stdin without hanging", async () => {
    await fixture(async ({ cli }) => {
      const result = await cli(["auth", "profile", "add", "--name", "new", "--json"], {
        stdin: "",
        env: { VANTA_CLIENT_SECRET: "" },
      });
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stderr).ok).toBe(false);
    });
  });
});

describe("bounded pagination", () => {
  test.each(
    [
      ["tests", "entities", "list", "test"],
      ["documents", "links", "document"],
      ["integrations", "resources", "integration", "servers"],
      ["audits", "code-changes", "list", "audit"],
    ].map((args) => ({ args })),
  )("supports --all for %j", async ({ args }) => {
    await fixture(
      async ({ cli, config, dir }) => {
        const result = await cli([...args, "--all", "--max-pages", "2", "--json"], {
          env: {
            VANTA_AUDITOR_CLIENT_ID: "auditor",
            VANTA_AUDITOR_CLIENT_SECRET: "synthetic",
            VANTA_AUDITOR_BASE_URL: config.baseUrl,
            VANTA_AUDITOR_TOKEN_CACHE_PATH: join(dir, "auditor-cache.json"),
          },
        });
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          results: { data: [{ id: "first" }, { id: "second" }] },
          scan: { pagesFetched: 2, complete: true },
        });
      },
      (request) => {
        const second = new URL(request.url).searchParams.has("pageCursor");
        return Response.json({
          results: {
            data: [{ id: second ? "second" : "first" }],
            pageInfo: { hasNextPage: !second, endCursor: second ? null : "next" },
          },
        });
      },
    );
  });
  test.each([undefined, "repeated"])(
    "rejects a missing or repeated cursor (%s)",
    async (endCursor) => {
      await fixture(
        async ({ config, requests }) => {
          const client = new VantaClient({ config, tokenManager: new TokenManager({ config }) });
          await expect(requestAll(client, "/v1/tests")).rejects.toThrow(
            endCursor ? "repeated pagination cursor" : "without an end cursor",
          );
          expect(requests.length).toBe(endCursor ? 3 : 2);
        },
        () =>
          Response.json({
            results: { data: [{ id: "first" }], pageInfo: { hasNextPage: true, endCursor } },
          }),
      );
    },
  );

  test("--all preserves filters and aggregates pages, with a hard bound", async () => {
    await fixture(
      async ({ cli, requests }) => {
        const args = [
          "tests",
          "list",
          "--all",
          "--query",
          "statusFilter=NEEDS_ATTENTION",
          "--json",
        ];
        const success = await cli([...args, "--max-pages", "2"]);
        expect(success.exitCode).toBe(0);
        expect(JSON.parse(success.stdout)).toMatchObject({
          results: { data: [{ id: "first" }, { id: "second" }], pageInfo: { hasNextPage: false } },
          scan: { pagesFetched: 2, complete: true },
        });
        expect(
          requests
            .filter((url) => url.includes("/v1/tests"))
            .every((url) => new URL(url).searchParams.get("statusFilter") === "NEEDS_ATTENTION"),
        ).toBe(true);
        const bounded = await cli([...args, "--max-pages", "1"]);
        expect(bounded.exitCode).toBe(1);
        expect(bounded.stdout).toBe("");
        expect(JSON.parse(bounded.stderr).error.message).toContain("page safety limit");
      },
      (request) => {
        const second = new URL(request.url).searchParams.has("pageCursor");
        return Response.json({
          results: {
            data: [{ id: second ? "second" : "first" }],
            pageInfo: { hasNextPage: !second, endCursor: second ? null : "next" },
          },
        });
      },
    );
  });
});

test("HTTP timeout aborts a stalled response", async () => {
  await fixture(
    async ({ cli }) => {
      const result = await cli(["raw", "GET", "/v1/slow", "--timeout-ms", "30", "--json"]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr).error.type).toBe("TimeoutError");
    },
    async () => {
      await Bun.sleep(150);
      return Response.json({ late: true });
    },
  );
});

describe("evidence and relationship commands", () => {
  test("new mutations are offline dry-runs and encode target IDs", async () => {
    await fixture(async ({ cli, requests }) => {
      for (const [args, method, path] of [
        [["documents", "submit", "doc/1"], "POST", "/v1/documents/doc%2F1/submit"],
        [
          ["documents", "add-link", "doc/1", "--body", '{"url":"https://example.com"}'],
          "POST",
          "/v1/documents/doc%2F1/links",
        ],
        [
          ["documents", "remove-link", "doc/1", "link/2"],
          "DELETE",
          "/v1/documents/doc%2F1/links/link%2F2",
        ],
      ] as const) {
        const result = await cli([...args, "--json"]);
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          dryRun: true,
          request: { method, path },
        });
      }
      expect(requests).toHaveLength(0);
    });
  });

  test("relationship reads paginate and preserve filters", async () => {
    await fixture(
      async ({ cli, requests }) => {
        for (const args of [
          ["frameworks", "controls"],
          ["controls", "tests"],
          ["controls", "documents"],
          ["documents", "controls"],
          ["documents", "uploads"],
        ]) {
          const result = await cli([...args, "id/1", "--all", "--query", "pageSize=1", "--json"]);
          expect(result.exitCode).toBe(0);
          expect(JSON.parse(result.stdout).results.data).toHaveLength(2);
        }
        expect(requests.filter((url) => url.includes("pageCursor=next"))).toHaveLength(5);
        expect(
          requests.filter((url) => url.includes("id%2F1") && url.includes("pageSize=1")),
        ).toHaveLength(10);
      },
      (request) =>
        Response.json({
          results: {
            data: [{ id: "item" }],
            pageInfo: {
              hasNextPage: !new URL(request.url).searchParams.has("pageCursor"),
              endCursor: "next",
            },
          },
        }),
    );
  });

  test("resource-kind discovery preserves its unpaginated array", async () => {
    await fixture(
      async ({ cli, requests }) => {
        const result = await cli(["integrations", "resource-kinds", "aws", "--json"]);
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual([{ resourceKind: "S3Bucket" }]);
        expect(requests.at(-1)).toEndWith("/v1/integrations/aws/resource-kinds");
      },
      () => Response.json([{ resourceKind: "S3Bucket" }]),
    );
  });

  test("upload metadata reaches multipart body and submit remains separate", async () => {
    const received: {
      path: string;
      method: string;
      description?: ReturnType<FormData["get"]>;
      effectiveAtDate?: ReturnType<FormData["get"]>;
      file?: string;
    }[] = [];
    await fixture(
      async ({ cli, dir }) => {
        const file = join(dir, "evidence.txt");
        await Bun.write(file, "review evidence");
        const args = [
          "documents",
          "upload",
          "doc1",
          "--file",
          file,
          "--description",
          "Access review",
          "--effective-at-date",
          "2026-09-18",
          "--json",
        ];
        const dry = await cli(args);
        expect(JSON.parse(dry.stdout).request.fields).toEqual({
          description: "Access review",
          effectiveAtDate: "2026-09-18",
        });
        expect(received).toHaveLength(0);
        expect((await cli([...args, "--apply", "--yes"])).exitCode).toBe(0);
        expect(received).toEqual([
          {
            path: "/v1/documents/doc1/uploads",
            method: "POST",
            description: "Access review",
            effectiveAtDate: "2026-09-18",
            file: "review evidence",
          },
        ]);
        const submit = await cli(["documents", "submit", "doc1", "--apply", "--yes", "--json"]);
        expect(submit.exitCode).toBe(0);
        expect(JSON.parse(submit.stdout)).toBeNull();
        expect(received.at(-1)).toEqual({ path: "/v1/documents/doc1/submit", method: "POST" });
      },
      async (request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/uploads")) {
          const form = await request.formData();
          const file = form.get("file");
          received.push({
            path,
            method: request.method,
            description: form.get("description"),
            effectiveAtDate: form.get("effectiveAtDate"),
            file: file instanceof Blob ? await file.text() : undefined,
          });
        } else received.push({ path, method: request.method });
        return new Response(null, { status: 204 });
      },
    );
  });
});
