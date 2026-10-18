import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

import { inspectTokenCache, TokenManager, writeTokenCache, type TokenCache } from "../src/auth.ts";
import { VantaClient } from "../src/api.ts";
import {
  DEFAULT_BASE_URL,
  DEFAULT_SCOPE,
  listProfiles,
  loadConfig,
  removeProfile,
  saveProfile,
} from "../src/config.ts";
import { requestAll } from "../src/dashboard.ts";
import { CliError, formatJsonError, VantaApiError } from "../src/errors.ts";
import { confirmWrite, parseBodyInput, parseQueryOptions } from "../src/io.ts";
import { PaginationGuard } from "../src/pagination.ts";
import { computeBackoffMs, isIdempotentMethod } from "../src/retry.ts";
import {
  deactivateEntityBody,
  findTestEntity,
  parseEntityPageSize,
  parseEntityStatus,
  type TestEntitiesClient,
  testEntityActionPath,
  testEntitiesPath,
} from "../src/test-entities.ts";
import { exitCodeForError, formatTokenOutput, parseRequiredBodyInput, v1 } from "../src/vanta.ts";

describe("config", () => {
  test("uses env-first defaults", () => {
    const config = loadConfig({
      configPath: "/tmp/vanta-cli-test-missing-config.json",
      env: {
        VANTA_CLIENT_ID: "vci_test",
        VANTA_CLIENT_SECRET: "vcs_test",
        VANTA_TOKEN_CACHE_PATH: "/tmp/vanta-token.json",
      },
    });

    expect(config.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(config.scope).toBe(DEFAULT_SCOPE);
    expect(config.clientId).toBe("vci_test");
    expect(config.clientSecret).toBe("vcs_test");
    expect(config.tokenCachePath).toBe("/tmp/vanta-token.json");
  });
});

describe("TokenManager", () => {
  test("reuses a valid cached token", async () => {
    const cache: TokenCache = {
      clientId: "vci_test",
      accessToken: "cached-token",
      baseUrl: DEFAULT_BASE_URL,
      scope: DEFAULT_SCOPE,
      expiresAt: 2_000_000,
    };
    let fetchCount = 0;
    const manager = new TokenManager({
      config: config(),
      now: () => 1_000_000,
      readCache: () => cache,
      writeCache: () => {},
      fetchImpl: (async () => {
        fetchCount += 1;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });

    await expect(manager.getToken()).resolves.toBe("cached-token");
    expect(fetchCount).toBe(0);
  });

  test("status redacts cached tokens", () => {
    const cache: TokenCache = {
      clientId: "vci_test",
      accessToken: "cached-token-that-must-not-print",
      baseUrl: DEFAULT_BASE_URL,
      scope: DEFAULT_SCOPE,
      expiresAt: 2_000_000,
    };
    const manager = new TokenManager({
      config: config(),
      now: () => 1_000_000,
      readCache: () => cache,
      writeCache: () => {},
    });

    const status = manager.status();

    expect(status).toMatchObject({
      configured: true,
      baseUrl: DEFAULT_BASE_URL,
      scope: DEFAULT_SCOPE,
      cacheUsable: true,
      cached: {
        baseUrl: DEFAULT_BASE_URL,
        scope: DEFAULT_SCOPE,
        expiresAt: 2_000_000,
      },
    });
    expect(JSON.stringify(status)).not.toContain(cache.accessToken);
  });

  test("issues one token for concurrent refreshes", async () => {
    let fetchCount = 0;
    const written: TokenCache[] = [];
    const manager = new TokenManager({
      config: config(),
      now: () => 1_000_000,
      readCache: () => undefined,
      writeCache: (_path, cache) => {
        written.push(cache);
      },
      fetchImpl: (async () => {
        fetchCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return Response.json({ access_token: "fresh-token", expires_in: 3600 });
      }) as unknown as typeof fetch,
    });

    const [first, second] = await Promise.all([manager.getToken(), manager.getToken()]);

    expect(first).toBe("fresh-token");
    expect(second).toBe("fresh-token");
    expect(fetchCount).toBe(1);
    expect(written).toHaveLength(1);
  });

  test("refreshes expired cache", async () => {
    const cache: TokenCache = {
      clientId: "vci_test",
      accessToken: "expired-token",
      baseUrl: DEFAULT_BASE_URL,
      scope: DEFAULT_SCOPE,
      expiresAt: 1_000_001,
    };
    const manager = new TokenManager({
      config: config(),
      now: () => 1_000_000,
      readCache: () => cache,
      writeCache: () => {},
      fetchImpl: (async () =>
        Response.json({
          access_token: "fresh-token",
          expires_in: 3600,
        })) as unknown as typeof fetch,
    });

    await expect(manager.getToken()).resolves.toBe("fresh-token");
  });

  test("writeTokenCache restricts existing cache file permissions", () => {
    const dir = `/tmp/vanta-cli-token-cache-${Date.now()}-${Math.random()}`;
    const path = `${dir}/token-cache.json`;
    const cache: TokenCache = {
      clientId: "vci_test",
      accessToken: "fresh-token",
      baseUrl: DEFAULT_BASE_URL,
      scope: DEFAULT_SCOPE,
      expiresAt: 2_000_000,
    };

    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, "{}\n", { mode: 0o644 });
      chmodSync(path, 0o644);

      writeTokenCache(path, cache);

      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(cache);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("reports a malformed cache without exposing its contents", async () => {
    const path = `/tmp/vanta-cli-malformed-cache-${Date.now()}-${Math.random()}.json`;
    try {
      await Bun.write(path, '{"accessToken":"must-not-print"');

      expect(inspectTokenCache(path)).toEqual({
        error: "Token cache is malformed or unreadable.",
      });
      const manager = new TokenManager({
        config: { ...config(), tokenCachePath: path },
      });
      expect(manager.status()).toMatchObject({
        cacheUsable: false,
        cacheError: "Token cache is malformed or unreadable.",
      });
      expect(JSON.stringify(manager.status())).not.toContain("must-not-print");
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe("io helpers", () => {
  test("parses repeated query options", () => {
    expect(parseQueryOptions(["status=active", "status=inactive", "limit=10"])).toEqual({
      status: ["active", "inactive"],
      limit: "10",
    });
  });

  test("rejects malformed query options", () => {
    expect(() => parseQueryOptions(["status"])).toThrow(CliError);
  });

  test("skips confirmation with --yes", async () => {
    await expect(confirmWrite("Delete vendor", { yes: true })).resolves.toBeUndefined();
  });

  test("parses body input from inline JSON or file", async () => {
    const bodyFile = `/tmp/vanta-cli-body-${Date.now()}.json`;
    await Bun.write(bodyFile, '{"displayName":"Vendor from file"}');

    expect(parseBodyInput({ body: '{"displayName":"Vendor"}' })).toEqual({
      displayName: "Vendor",
    });
    expect(parseBodyInput({ bodyFile })).toEqual({ displayName: "Vendor from file" });
  });

  test("rejects ambiguous or missing required body input", () => {
    expect(() => parseBodyInput({ body: "{}", bodyFile: "/tmp/body.json" })).toThrow(CliError);
    expect(() => parseRequiredBodyInput({})).toThrow(CliError);
  });

  test("emits complete JSON when stdout is a Unix pipe", async () => {
    const producerPath = `/tmp/vanta-cli-producer-${Date.now()}-${Math.random()}.ts`;
    const consumerPath = `/tmp/vanta-cli-consumer-${Date.now()}-${Math.random()}.ts`;
    const repoRoot = import.meta.dir.replace(/\/test$/, "");
    const producer = [
      `import { printResult } from ${JSON.stringify(`${repoRoot}/src/io.ts`)};`,
      'printResult({ payload: "x".repeat(2000) }, { json: true });',
    ].join(" ");
    const consumer = [
      "const text = await Bun.stdin.text();",
      "const parsed = JSON.parse(text);",
      "if (parsed.payload.length !== 2000) process.exit(2);",
    ].join(" ");
    try {
      await Promise.all([Bun.write(producerPath, producer), Bun.write(consumerPath, consumer)]);
      const proc = Bun.spawn(["sh", "-c", `bun ${producerPath} | bun ${consumerPath}`], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [exitCode, stderr] = await Promise.all([proc.exited, proc.stderr.text()]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
    } finally {
      rmSync(producerPath, { force: true });
      rmSync(consumerPath, { force: true });
    }
  });
});

describe("VantaClient downloads", () => {
  test("refuses to overwrite an output file unless force is explicit", async () => {
    const outputPath = `/tmp/vanta-cli-download-${Date.now()}-${Math.random()}.txt`;
    let fetchCount = 0;
    const client = new VantaClient({
      config: config(),
      tokenManager: { getToken: async () => "test-token" } as never,
      fetchImpl: (async () => {
        fetchCount += 1;
        return new Response("replacement");
      }) as unknown as typeof fetch,
    });

    try {
      await Bun.write(outputPath, "original");
      await expect(client.download("/v1/file", outputPath)).rejects.toThrow(CliError);
      expect(fetchCount).toBe(0);
      expect(await Bun.file(outputPath).text()).toBe("original");

      await expect(client.download("/v1/file", outputPath, { force: true })).resolves.toEqual({
        outputPath,
        bytes: 11,
      });
      expect(fetchCount).toBe(1);
      expect(await Bun.file(outputPath).text()).toBe("replacement");
    } finally {
      rmSync(outputPath, { force: true });
    }
  });
});

describe("pagination safety", () => {
  test("rejects missing and repeated next-page cursors", () => {
    const missing = new PaginationGuard("Example pagination");
    missing.startPage();
    expect(() => missing.nextCursor({ hasNextPage: true })).toThrow(
      "reported another page without an end cursor",
    );

    const repeated = new PaginationGuard("Example pagination");
    repeated.startPage();
    expect(repeated.nextCursor({ hasNextPage: true, endCursor: "same" })).toBe("same");
    repeated.startPage();
    expect(() => repeated.nextCursor({ hasNextPage: true, endCursor: "same" })).toThrow(
      "repeated pagination cursor",
    );
  });

  test("enforces an explicit page bound", () => {
    const pagination = new PaginationGuard("Example pagination", 1);
    pagination.startPage();
    expect(() => pagination.startPage()).toThrow("exceeded the 1-page safety limit");
  });
});

describe("auth output helpers", () => {
  test("redacts token output by default", () => {
    const status = tokenStatus();
    const output = formatTokenOutput("vanta_access_token_secret", status, false);

    expect(output).toMatchObject({
      accessToken: "vanta_...secret",
      redacted: true,
      baseUrl: DEFAULT_BASE_URL,
      scope: DEFAULT_SCOPE,
      expiresAt: 2_000_000,
    });
    expect(JSON.stringify(output)).not.toContain("vanta_access_token_secret");
  });

  test("reveals token output only when requested", () => {
    const output = formatTokenOutput("vanta_access_token_secret", tokenStatus(), true);

    expect(output).toMatchObject({
      accessToken: "vanta_access_token_secret",
      redacted: false,
    });
  });
});

describe("CLI error handling", () => {
  test("preserves CliError exit codes", () => {
    expect(exitCodeForError(new CliError("Aborted.", 2))).toBe(2);
  });

  test("uses exit code 1 for non-CliError failures", () => {
    expect(exitCodeForError(new Error("boom"))).toBe(1);
  });

  test("formats machine-readable errors without response bodies", () => {
    const output = formatJsonError(
      new VantaApiError(401, { access_token: "must-not-print" }, "Request failed"),
    );

    expect(output).toMatchObject({
      ok: false,
      error: { type: "VantaApiError", message: "Request failed", status: 401 },
    });
    expect(JSON.stringify(output)).not.toContain("must-not-print");
  });

  test("real CLI exits 2 when a mutating command is declined", async () => {
    const result = await runCli(
      ["--json", "--apply", "controls", "deactivate", "ctrl_smoke_test"],
      {
        stdin: "no\n",
      },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Proceed? Type yes to continue:");
    expect(result.stderr).toContain("Aborted.");
  });

  test("real CLI dry-runs mutating commands by default", async () => {
    const result = await runCli(["controls", "deactivate", "ctrl_smoke_test", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      mutation: true,
      requiresApply: true,
      confirmationRequired: true,
      request: { method: "DELETE", path: "/v1/controls/ctrl_smoke_test" },
    });
  });

  test("real CLI dry-runs convenience body-file mutations without credentials", async () => {
    const bodyFile = `/tmp/vanta-cli-body-file-${Date.now()}.json`;
    await Bun.write(bodyFile, '{"displayName":"Vendor from body file"}');

    const result = await runCli(["vendors", "create", "--body-file", bodyFile, "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      mutation: true,
      request: {
        method: "POST",
        path: "/v1/vendors",
        body: { displayName: "Vendor from body file" },
      },
    });
  });

  test("test entity deactivation dry-runs with the typed request body", async () => {
    const result = await runCli([
      "tests",
      "entities",
      "deactivate",
      "test_123",
      "entity_456",
      "--reason",
      "Accepted exception",
      "--until",
      "2026-12-31T23:59:59Z",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      request: {
        method: "POST",
        path: "/v1/tests/test_123/entities/entity_456/deactivate",
        body: {
          deactivateReason: "Accepted exception",
          deactivateUntilDate: "2026-12-31T23:59:59Z",
        },
      },
    });
  });

  test("test entity reactivation dry-runs without a request body", async () => {
    const result = await runCli([
      "tests",
      "entities",
      "reactivate",
      "test_123",
      "entity_456",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      request: {
        method: "POST",
        path: "/v1/tests/test_123/entities/entity_456/reactivate",
      },
    });
  });

  test("test entity deactivation validates its reason and expiry before credentials", async () => {
    const emptyReason = await runCli([
      "tests",
      "entities",
      "deactivate",
      "test_123",
      "entity_456",
      "--reason",
      "   ",
    ]);
    const badExpiry = await runCli([
      "tests",
      "entities",
      "deactivate",
      "test_123",
      "entity_456",
      "--reason",
      "Accepted exception",
      "--until",
      "tomorrow",
    ]);

    expect(emptyReason.exitCode).toBe(1);
    expect(emptyReason.stderr).toContain("--reason must not be empty.");
    expect(emptyReason.stderr).not.toContain("at parse");
    expect(badExpiry.exitCode).toBe(1);
    expect(badExpiry.stderr).toContain("--until must be an RFC 3339 date-time");
    expect(badExpiry.stderr).not.toContain("at parse");
  });

  test("test entity validation follows the global debug error policy", async () => {
    const result = await runCli([
      "--debug",
      "tests",
      "entities",
      "list",
      "test_123",
      "--page-size",
      "101",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--page-size must be an integer from 1 to 100.");
    expect(result.stderr).toContain("at parseEntityPageSize");
  });

  test("real CLI doctor runs without credentials", async () => {
    const result = await runCli(["doctor", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      configured: false,
      tokenCache: { exists: false, usable: false },
      api: { checked: false, ok: false, reason: "credentials_not_configured" },
    });
  });

  test("real CLI doctor reports a malformed cache without failing", async () => {
    const tokenCachePath = `/tmp/vanta-cli-malformed-doctor-${Date.now()}-${Math.random()}.json`;
    try {
      await Bun.write(tokenCachePath, "not-json");
      const result = await runCli(["doctor", "--json"], { tokenCachePath });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        configured: false,
        tokenCache: {
          exists: true,
          usable: false,
          error: "Token cache is malformed or unreadable.",
        },
      });
    } finally {
      rmSync(tokenCachePath, { force: true });
    }
  });

  test("real CLI exits 1 for normal failures", async () => {
    const result = await runCli(["auth", "token", "--force-refresh"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Missing Vanta credentials.");
  });

  test("real CLI emits JSON errors on stderr under --json", async () => {
    const result = await runCli(["auth", "token", "--force-refresh", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { type: "Error", message: expect.stringContaining("Missing Vanta credentials") },
    });
  });
});

describe("CLI path helpers", () => {
  test("prefixes Manage API paths with v1", () => {
    expect(v1("/frameworks")).toBe("/v1/frameworks");
    expect(v1("frameworks")).toBe("/v1/frameworks");
  });

  test("does not double-prefix v1 paths", () => {
    expect(v1("/v1/frameworks")).toBe("/v1/frameworks");
  });
});

describe("test entity helpers", () => {
  test("builds encoded entity paths", () => {
    expect(testEntitiesPath("test/a")).toBe("/v1/tests/test%2Fa/entities");
    expect(testEntityActionPath("test/a", "entity/b", "deactivate")).toBe(
      "/v1/tests/test%2Fa/entities/entity%2Fb/deactivate",
    );
  });

  test("normalizes entity status and validates page size", () => {
    expect(parseEntityStatus("failing")).toBe("FAILING");
    expect(parseEntityStatus("DEACTIVATED")).toBe("DEACTIVATED");
    expect(parseEntityPageSize("100")).toBe(100);
    expect(parseEntityPageSize()).toBeUndefined();
    expect(() => parseEntityStatus("passing")).toThrow(CliError);
    expect(() => parseEntityPageSize("101")).toThrow(CliError);
    expect(() => parseEntityPageSize("1.5")).toThrow(CliError);
  });

  test("validates and trims test entity deactivation bodies", () => {
    expect(deactivateEntityBody("  Accepted exception  ")).toEqual({
      deactivateReason: "Accepted exception",
    });
    expect(deactivateEntityBody("Accepted exception", "2026-12-31T23:59:59+01:00")).toEqual({
      deactivateReason: "Accepted exception",
      deactivateUntilDate: "2026-12-31T23:59:59+01:00",
    });
    expect(() => deactivateEntityBody(" ")).toThrow(CliError);
    expect(() => deactivateEntityBody("Accepted exception", "2026-12-31")).toThrow(CliError);
  });

  test("finds an entity across result pages in the expected state", async () => {
    const calls: unknown[] = [];
    const client: TestEntitiesClient = {
      request: async (request: unknown) => {
        calls.push(request);
        if (calls.length === 1) {
          return {
            results: {
              data: [],
              pageInfo: { hasNextPage: true, endCursor: "next-page" },
            },
          };
        }
        return {
          results: {
            data: [
              {
                id: "entity_456",
                entityStatus: "FAILING",
                displayName: "example bucket",
                responseType: "S3 bucket",
                deactivatedReason: null,
                lastUpdatedDate: "2026-01-01T00:00:00Z",
                createdDate: "2026-01-01T00:00:00Z",
              },
            ],
            pageInfo: { hasNextPage: false },
          },
        };
      },
    };

    await expect(
      findTestEntity(client, "test_123", "entity_456", "FAILING"),
    ).resolves.toMatchObject({
      displayName: "example bucket",
    });
    expect(calls).toHaveLength(2);
  });
});

describe("retry helpers", () => {
  test("classifies idempotent methods", () => {
    expect(isIdempotentMethod("GET")).toBe(true);
    expect(isIdempotentMethod("post")).toBe(false);
  });

  test("honours Retry-After seconds and caps delay", () => {
    expect(computeBackoffMs(0, "2")).toBe(2000);
    expect(computeBackoffMs(0, "999")).toBe(10_000);
    expect(computeBackoffMs(0, null)).toBe(500);
  });
});

describe("API client retries", () => {
  test("retries idempotent GETs on 429 then succeeds", async () => {
    let calls = 0;
    const client = new VantaClient({
      config: config(),
      tokenManager: {
        getToken: async () => "token",
      } as TokenManager,
      backoff: { baseDelayMs: 1, maxDelayMs: 5, maxRetries: 2 },
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ error: "rate limited" }), {
            status: 429,
            headers: { "retry-after": "0", "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    await expect(client.request({ path: "/v1/frameworks" })).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  test("does not retry mutations after 500", async () => {
    let calls = 0;
    const client = new VantaClient({
      config: config(),
      tokenManager: {
        getToken: async () => "token",
      } as TokenManager,
      backoff: { baseDelayMs: 1, maxDelayMs: 5, maxRetries: 3 },
      fetchImpl: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: "boom" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    await expect(
      client.request({ method: "POST", path: "/v1/documents", body: {} }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe("requestAll pagination bounds", () => {
  test("throws when maxPages is hit with more results available", async () => {
    let calls = 0;
    const client = {
      request: async () => {
        calls += 1;
        return {
          results: {
            data: [{ id: `p${calls}` }],
            pageInfo: { hasNextPage: true, endCursor: `c${calls}` },
          },
        };
      },
    } as unknown as VantaClient;

    await expect(
      requestAll<{ id: string }>(client, "/v1/tests", {}, { maxPages: 2 }),
    ).rejects.toThrow(CliError);
    expect(calls).toBe(2);
  });
});

describe("credential profiles", () => {
  test("saves, lists, and removes a profile without exposing secrets in list", () => {
    const dir = `/tmp/vanta-cli-profiles-${Date.now()}`;
    const env = { VANTA_PROFILES_DIR: dir } as NodeJS.ProcessEnv;
    const path = saveProfile(
      "client-a",
      { clientId: "vci_a", clientSecret: "vcs_a", scope: "vanta-api.all:read" },
      { env },
    );
    expect(path).toContain("client-a.json");
    expect(listProfiles(env)).toEqual([
      { name: "client-a", path, hasClientId: true, hasAuditor: false },
    ]);

    const loaded = loadConfig({
      env: { ...env, VANTA_PROFILE: "client-a" },
    });
    expect(loaded.clientId).toBe("vci_a");
    expect(loaded.profile).toBe("client-a");
    expect(loaded.tokenCachePath).toContain("client-a.json");

    expect(() =>
      loadConfig({
        env: {
          ...env,
          VANTA_PROFILE: "client-a",
          VANTA_CLIENT_ID: "conflict",
        },
      }),
    ).toThrow(CliError);

    removeProfile("client-a", env);
    expect(listProfiles(env)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("credentialed CLI smoke tests", () => {
  test.if(hasLocalVantaCredentials())(
    "frameworks list uses the convenience command path",
    async () => {
      const result = await runCli(["frameworks", "list", "--query", "pageSize=1", "--json"], {
        useLocalCredentials: true,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toHaveProperty("results");
    },
    30_000,
  );

  test.if(hasLocalVantaCredentials())(
    "dashboard failing-tests returns automated and document rows",
    async () => {
      const result = await runCli(
        [
          "dashboard",
          "failing-tests",
          "--framework",
          "gdpr",
          "--framework",
          "iso27001_2022",
          "--framework",
          "soc2",
          "--status",
          "overdue",
          "--status",
          "due-soon",
          "--status",
          "needs-remediation",
          "--json",
        ],
        { useLocalCredentials: true },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout);
      expect(parsed.summary.total).toBe(parsed.data.length);
      expect(parsed.summary.byType.automated).toBeGreaterThanOrEqual(0);
      expect(parsed.summary.byType.document).toBeGreaterThanOrEqual(0);
      expect(parsed.summary.byStatus).toHaveProperty("due-soon");
    },
    30_000,
  );
});

function config() {
  return {
    baseUrl: DEFAULT_BASE_URL,
    clientId: "vci_test",
    clientSecret: "vcs_test",
    scope: DEFAULT_SCOPE,
    tokenCachePath: "/tmp/vanta-token.json",
  };
}

async function runCli(
  args: string[],
  options: { stdin?: string; useLocalCredentials?: boolean; tokenCachePath?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = { ...process.env };
  if (!options.useLocalCredentials) {
    for (const key of Object.keys(env)) {
      if (key.startsWith("VANTA_")) delete env[key];
    }
    delete env.VANTA_CLIENT_ID;
    delete env.VANTA_CLIENT_SECRET;
    delete env.VANTA_AUDITOR_CLIENT_ID;
    delete env.VANTA_AUDITOR_CLIENT_SECRET;
    env.VANTA_TOKEN_CACHE_PATH =
      options.tokenCachePath ??
      `/tmp/vanta-cli-missing-token-cache-${Date.now()}-${Math.random()}.json`;
    env.VANTA_AUDITOR_TOKEN_CACHE_PATH = `/tmp/vanta-cli-missing-auditor-token-cache-${Date.now()}-${Math.random()}.json`;
  }

  const configArgs = options.useLocalCredentials
    ? []
    : ["--config", "/tmp/vanta-cli-missing-config.json"];
  const proc = Bun.spawn(["bun", "--no-env-file", "run", "src/vanta.ts", ...configArgs, ...args], {
    cwd: import.meta.dir.replace(/\/test$/, ""),
    env,
    stdin: options.stdin === undefined ? undefined : new Response(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    proc.stdout.text(),
    proc.stderr.text(),
  ]);
  return { exitCode, stdout, stderr };
}

function hasLocalVantaCredentials(): boolean {
  if (process.env.VANTA_LIVE_TESTS !== "1") return false;
  const config = loadConfig();
  return Boolean(config.clientId && config.clientSecret);
}

function tokenStatus() {
  return {
    configured: true,
    baseUrl: DEFAULT_BASE_URL,
    scope: DEFAULT_SCOPE,
    tokenCachePath: "/tmp/vanta-token.json",
    cached: {
      baseUrl: DEFAULT_BASE_URL,
      scope: DEFAULT_SCOPE,
      expiresAt: 2_000_000,
      expiresAtIso: new Date(2_000_000).toISOString(),
    },
    cacheUsable: true,
  };
}
