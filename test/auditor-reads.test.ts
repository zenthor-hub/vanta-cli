import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const entrypoint = join(root, "src/vanta.ts");
const page = (data: unknown[], next?: string) => ({
  results: {
    data,
    pageInfo: { hasNextPage: next !== undefined, ...(next ? { endCursor: next } : {}) },
  },
});

type Call = {
  api: string;
  path: string;
  query: URLSearchParams;
  method: string;
  authorization: string | null;
  body: unknown;
};

async function fixture(
  use: (context: {
    calls: Call[];
    cli: (
      args: string[],
      profile?: "full" | "manage-only" | "other",
      json?: boolean,
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  }) => Promise<void>,
  respond: (call: Call) => Response = () => Response.json(page([])),
) {
  const dir = mkdtempSync(join(tmpdir(), "vanta-auditor-reads-"));
  const calls: Call[] = [];
  function server(api: string) {
    return Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const call = {
          api,
          path: url.pathname,
          query: url.searchParams,
          method: request.method,
          authorization: request.headers.get("authorization"),
          body: request.method === "POST" ? await request.json() : undefined,
        };
        calls.push(call);
        if (call.path === "/oauth/token")
          return Response.json({ access_token: `${api}-token`, expires_in: 3600 });
        return respond(call);
      },
    });
  }
  const manage = server("manage");
  const auditor = server("auditor");
  const config = {
    clientId: "synthetic-manage",
    clientSecret: "synthetic-manage-secret",
    baseUrl: manage.url.origin,
    tokenCachePath: join(dir, "manage-token.json"),
    auditorClientId: "synthetic-auditor",
    auditorClientSecret: "synthetic-auditor-secret",
    auditorBaseUrl: auditor.url.origin,
    auditorTokenCachePath: join(dir, "auditor-token.json"),
  };
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  const profiles = join(dir, "profiles");
  mkdirSync(profiles);
  writeFileSync(join(profiles, "full.json"), JSON.stringify(config));
  writeFileSync(
    join(profiles, "manage-only.json"),
    JSON.stringify({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      baseUrl: config.baseUrl,
      tokenCachePath: config.tokenCachePath,
    }),
  );
  writeFileSync(
    join(profiles, "other.json"),
    JSON.stringify({
      ...config,
      auditorClientId: "synthetic-other",
      auditorTokenCachePath: join(dir, "other-token.json"),
    }),
  );
  try {
    await use({
      calls,
      async cli(args, profile, json = true) {
        const child = Bun.spawn(
          [
            process.execPath,
            "--no-env-file",
            entrypoint,
            ...(json ? ["--json"] : []),
            ...(profile ? ["--profile", profile] : ["--config", configPath]),
            ...args,
          ],
          {
            cwd: root,
            env: {
              ...Object.fromEntries(
                Object.entries(process.env).filter(([key]) => !key.startsWith("VANTA_")),
              ),
              VANTA_PROFILES_DIR: profiles,
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const timeout = setTimeout(() => child.kill(), 10000);
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
    manage.stop(true);
    auditor.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

const namedReads = [
  { args: ["list"], path: "/v1/audits", collection: true },
  { args: ["get", "audit/a"], path: "/v1/audits/audit%2Fa" },
  {
    args: ["controls", "list", "audit/a"],
    path: "/v1/audits/audit%2Fa/controls",
    collection: true,
  },
  {
    args: ["evidence", "list", "audit/a"],
    path: "/v1/audits/audit%2Fa/evidence",
    collection: true,
  },
  { args: ["evidence", "get", "audit/a", "ev/a"], path: "/v1/audits/audit%2Fa/evidence/ev%2Fa" },
  {
    args: ["evidence", "urls", "audit/a", "ev/a"],
    path: "/v1/audits/audit%2Fa/evidence/ev%2Fa/urls",
    collection: true,
  },
  {
    args: ["information-requests", "list", "audit/a"],
    path: "/v1/audits/audit%2Fa/information-requests",
    collection: true,
  },
  {
    args: ["information-requests", "get", "audit/a", "req/a"],
    path: "/v1/audits/audit%2Fa/information-requests/req%2Fa",
  },
];
for (const read of namedReads) {
  test(`Auditor named read ${read.args.join(" ")}`, async () => {
    const record = { id: "deleted", deletionDate: "2026-10-01T00:00:00Z" };
    await fixture(
      async ({ cli, calls }) => {
        const result = await cli([
          "audits",
          ...read.args,
          ...(read.collection ? ["--query", "pageSize=10"] : []),
        ]);
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(read.collection ? page([record]) : record);
        const request = calls.find((call) => call.path !== "/oauth/token");
        expect(request).toMatchObject({
          api: "auditor",
          path: read.path,
          method: "GET",
          authorization: "Bearer auditor-token",
        });
        if (read.collection) expect(request?.query.get("pageSize")).toBe("10");
        expect(calls[0]?.body).toMatchObject({
          client_id: "synthetic-auditor",
          scope: "auditor-api.audit:read",
        });
      },
      () => Response.json(read.collection ? page([record]) : record),
    );
  });
}

test("Auditor collection and raw scans preserve filters, tail cursor and deletion rows", async () => {
  await fixture(
    async ({ cli, calls }) => {
      for (const args of [
        ["audits", "controls", "list", "audit/a"],
        ["raw", "GET", "/v1/audits/audit%2Fa/controls", "--api", "auditor"],
      ]) {
        const result = await cli([
          ...args,
          "--all",
          "--max-pages",
          "2",
          "--query",
          "pageCursor=start",
          "--query",
          "externalIdMatchesAny=first",
          "--query",
          "externalIdMatchesAny=second",
        ]);
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          ...page([
            { id: "start", deletionDate: null },
            { id: "next", deletionDate: "2026-10-01" },
          ]),
          scan: { pagesFetched: 2, complete: true, startedAtCursor: "start" },
        });
      }
      const requests = calls.filter((call) => call.path !== "/oauth/token");
      expect(requests).toHaveLength(4);
      for (const request of requests)
        expect(request.query.getAll("externalIdMatchesAny")).toEqual(["first", "second"]);
      expect(calls.filter((call) => call.path === "/oauth/token")).toHaveLength(1);
    },
    (call) =>
      Response.json(
        page(
          [
            {
              id: call.query.get("pageCursor"),
              deletionDate: call.query.get("pageCursor") === "start" ? null : "2026-10-01",
            },
          ],
          call.query.get("pageCursor") === "start" ? "next" : undefined,
        ),
      ),
  );
});

test("Auditor raw validation rejects mutations and transport before config or token calls", async () => {
  await fixture(async ({ cli, calls }) => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"]) {
      for (const flags of [[], ["--apply", "--yes"]]) {
        const result = await cli(
          ["raw", method, "/v1/audits", "--api", "auditor", ...flags],
          "manage-only",
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Auditor raw supports GET only");
      }
    }
    for (const flags of [
      ["--body", "{}"],
      ["--body-file", "/missing.json"],
      ["--form", "field=text"],
      ["--file", "file=/missing.pdf"],
      ["--file-type", "file=application/pdf"],
      ["--output", "/missing.bin"],
      ["--force"],
    ]) {
      const result = await cli(
        ["raw", "GET", "/v1/audits", "--api", "auditor", ...flags],
        "manage-only",
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Auditor raw does not support");
    }
    expect((await cli(["raw", "GET", "/audits", "--api", "auditor"])).stderr).toContain(
      "exact /v1/ path",
    );
    expect((await cli(["raw", "GET", "/v1/audits", "--api", "invalid"])).stderr).toContain(
      "--api must be",
    );
    expect(calls).toHaveLength(0);
  });
});

test("Auditor profile routing never falls back to Manage credentials or cache", async () => {
  await fixture(async ({ cli, calls }) => {
    expect((await cli(["raw", "GET", "/v1/audits"], "manage-only")).exitCode).toBe(0);
    const before = calls.length;
    for (const args of [
      ["audits", "list"],
      ["raw", "GET", "/v1/audits", "--api", "auditor"],
    ]) {
      const missing = await cli(args, "manage-only");
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toContain("Missing Vanta Auditor API credentials");
      expect(calls).toHaveLength(before);
    }
    expect((await cli(["audits", "list"], "full")).exitCode).toBe(0);
    expect((await cli(["raw", "GET", "/v1/audits", "--api", "auditor"], "full")).exitCode).toBe(0);
    expect((await cli(["audits", "list"], "other")).exitCode).toBe(0);
    expect(calls.filter((call) => call.path === "/oauth/token").map((call) => call.body)).toEqual([
      {
        client_id: "synthetic-manage",
        client_secret: "synthetic-manage-secret",
        scope: "vanta-api.all:read",
        grant_type: "client_credentials",
      },
      {
        client_id: "synthetic-auditor",
        client_secret: "synthetic-auditor-secret",
        scope: "auditor-api.audit:read",
        grant_type: "client_credentials",
      },
      {
        client_id: "synthetic-other",
        client_secret: "synthetic-auditor-secret",
        scope: "auditor-api.audit:read",
        grant_type: "client_credentials",
      },
    ]);
  });
});

for (const status of [401, 403, 404, 422]) {
  test(`Auditor evidence URLs surface HTTP ${status} without extra signed URL output`, async () => {
    await fixture(
      async ({ cli, calls }) => {
        const result = await cli(["audits", "evidence", "urls", "a", "e"]);
        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stderr).error.status).toBe(status);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toContain("signed.example");
        if (status === 401) expect(result.stderr).toContain("VANTA_AUDITOR_CLIENT_ID");
        if (status === 403) expect(result.stderr).toContain("VANTA_AUDITOR_SCOPE");
        const text = await cli(["audits", "evidence", "urls", "a", "e"], undefined, false);
        expect(text.exitCode).toBe(1);
        expect(text.stdout).toBe("");
        expect(text.stderr).toContain(`status ${status}`);
        expect(text.stderr).not.toContain("signed.example");
        if (status === 401) expect(text.stderr).toContain("VANTA_AUDITOR_CLIENT_ID");
        if (status === 403) expect(text.stderr).toContain("VANTA_AUDITOR_SCOPE");
        expect(calls.filter((call) => call.path !== "/oauth/token")).toHaveLength(2);
      },
      () => Response.json({ message: "https://signed.example/file?secret=synthetic" }, { status }),
    );
  });
}

test("Auditor URLs are output without fetching them and GET retries honor existing 429 policy", async () => {
  let attempts = 0;
  const signed = "https://signed.example/file?signature=synthetic";
  await fixture(
    async ({ cli, calls }) => {
      const result = await cli(["audits", "evidence", "urls", "a", "e"]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(page([{ url: signed }]));
      expect(result.stderr).toBe("");
      expect(calls.filter((call) => call.path !== "/oauth/token")).toHaveLength(2);
    },
    () =>
      ++attempts === 1
        ? Response.json({}, { status: 429, headers: { "retry-after": "0" } })
        : Response.json(page([{ url: signed }])),
  );
});
