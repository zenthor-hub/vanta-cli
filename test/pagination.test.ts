import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entrypoint = resolve(import.meta.dir, "../src/vanta.ts");

async function scanFixture(args: string[], respond: (request: Request, page: number) => unknown) {
  const dir = mkdtempSync(join(tmpdir(), "vanta-page-shape-"));
  const requests: URL[] = [];
  let tokenRequests = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/oauth/token") {
        tokenRequests++;
        return Response.json({ access_token: "synthetic-token", expires_in: 3600 });
      }
      requests.push(url);
      return Response.json(respond(request, requests.length));
    },
  });
  try {
    const child = Bun.spawn([process.execPath, entrypoint, ...args, "--json"], {
      cwd: dir,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("VANTA_")),
        ),
        VANTA_CLIENT_ID: "fixture-client",
        VANTA_CLIENT_SECRET: "fixture-secret",
        VANTA_BASE_URL: server.url.origin,
        VANTA_TOKEN_CACHE_PATH: join(dir, "token.json"),
        VANTA_CONFIG_PATH: join(dir, "missing-config.json"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      child.stdout.text(),
      child.stderr.text(),
    ]);
    return { exitCode, stdout, stderr, requests, tokenRequests };
  } finally {
    server.stop(true);
    rmSync(dir, { force: true, recursive: true });
  }
}

const invalidPages = [
  null,
  [],
  "plain response",
  {},
  { results: {} },
  { results: { data: {}, pageInfo: { hasNextPage: false } } },
  { results: { data: [], pageInfo: {} } },
  { results: { data: [], pageInfo: { hasNextPage: null } } },
  { results: { data: [], pageInfo: { hasNextPage: "false" } } },
  { results: { data: [], pageInfo: { hasNextPage: false, endCursor: 10 } } },
];

test.each(invalidPages.map((response) => ({ response })))(
  "collection scans reject malformed page envelopes %j",
  async ({ response }) => {
    const result = await scanFixture(["tests", "list", "--all"], () => response);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error.message).toContain("/v1/tests");
    expect(JSON.parse(result.stderr).error.message).toContain("page 1");
    expect(result.requests).toHaveLength(1);
  },
);

test("a malformed later page never emits accumulated rows as success", async () => {
  const result = await scanFixture(["tests", "list", "--all"], (_request, page) =>
    page === 1
      ? { results: { data: [{ id: "first" }], pageInfo: { hasNextPage: true, endCursor: "next" } } }
      : { results: { data: [{ id: "second" }], pageInfo: { hasNextPage: 0 } } },
  );
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).error.message).toContain("page 2");
  expect(result.requests).toHaveLength(2);
});

test("scans preserve a starting cursor, repeated filters and server ordering", async () => {
  const result = await scanFixture(
    [
      "tests",
      "list",
      "--all",
      "--query",
      "pageCursor=start",
      "--query",
      "tag=a",
      "--query",
      "tag=b",
    ],
    (_request, page) => ({
      results: {
        data: [{ id: page === 1 ? "second" : "third" }],
        pageInfo: { hasNextPage: page === 1, endCursor: page === 1 ? "next" : null },
        totalCount: 10,
      },
    }),
  );
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    results: { data: [{ id: "second" }, { id: "third" }], pageInfo: { hasNextPage: false } },
    scan: { pagesFetched: 2, complete: true, startedAtCursor: "start" },
  });
  expect(result.requests.map((url) => url.searchParams.get("pageCursor"))).toEqual([
    "start",
    "next",
  ]);
  expect(result.requests.every((url) => url.searchParams.getAll("tag").join(",") === "a,b")).toBe(
    true,
  );
});

test("a complete empty collection records that it started at the beginning", async () => {
  const result = await scanFixture(["tests", "list", "--all"], () => ({
    results: { data: [], pageInfo: { hasNextPage: false } },
  }));
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).scan).toEqual({
    pagesFetched: 1,
    complete: true,
    startedAtCursor: null,
  });
});

test("single-page reads preserve endpoint-specific metadata", async () => {
  const response = { results: { data: [], pageInfo: { hasNextPage: false }, totalCount: 20 } };
  const result = await scanFixture(["tests", "list"], () => response);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(response);
});

test("raw scans use the same bounded envelope and retain repeated query filters", async () => {
  const result = await scanFixture(
    [
      "raw",
      "GET",
      "/v1/example",
      "--all",
      "--max-pages",
      "2",
      "--query",
      "tag=a",
      "--query",
      "tag=b",
    ],
    (_request, page) => ({
      results: {
        data: [{ id: page }],
        pageInfo: { hasNextPage: page === 1, endCursor: page === 1 ? "next" : null },
      },
    }),
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).scan).toEqual({
    pagesFetched: 2,
    complete: true,
    startedAtCursor: null,
  });
  expect(result.requests.every((url) => url.searchParams.getAll("tag").join(",") === "a,b")).toBe(
    true,
  );
});

test.each(
  [
    ["raw", "POST", "/v1/example", "--all"],
    ["raw", "GET", "/v1/example", "--all", "--body", "{}"],
    ["raw", "GET", "/v1/example", "--all", "--body-file", "/missing-body.json"],
    ["raw", "GET", "/v1/example", "--all", "--form", "name=test"],
    ["raw", "GET", "/v1/example", "--all", "--file", "file=/missing-file.pdf"],
    ["raw", "GET", "/v1/example", "--all", "--output", "/missing-output.bin"],
    ["raw", "GET", "/v1/example", "--all", "--max-pages", "0"],
  ].map((args) => ({ args })),
)("raw rejects incompatible scan options %j before token exchange", async ({ args }) => {
  const result = await scanFixture(args, () => ({
    results: { data: [], pageInfo: { hasNextPage: false } },
  }));
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).ok).toBe(false);
  expect(result.requests).toHaveLength(0);
  expect(result.tokenRequests).toBe(0);
});

test("raw page-bound failure never returns a partial aggregate", async () => {
  const result = await scanFixture(
    ["raw", "GET", "/v1/example", "--all", "--max-pages", "1"],
    () => ({
      results: { data: [{ id: "first" }], pageInfo: { hasNextPage: true, endCursor: "next" } },
    }),
  );
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).error.message).toContain("page safety limit");
  expect(result.requests).toHaveLength(1);
});
