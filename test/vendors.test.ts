import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entrypoint = resolve(import.meta.dir, "../src/vanta.ts");
const vendorId = "vendor/a";
const reviewId = "review/a";
const base = "/v1/vendors/vendor%2Fa";
const review = `${base}/security-reviews/review%2Fa`;
const page = (data: unknown[], hasNextPage = false, endCursor?: string) => ({
  results: { data, pageInfo: { hasNextPage, endCursor } },
});

async function fixture(
  operate: (fixture: {
    file: string;
    requests: string[];
    cli: (args: string[], stdin?: string) => Promise<{ code: number; out: string; err: string }>;
  }) => Promise<void>,
  respond: (request: Request) => Response | Promise<Response>,
) {
  const dir = mkdtempSync(join(tmpdir(), "vanta-vendors-"));
  const file = join(dir, "evidence.pdf");
  writeFileSync(file, "%PDF-fixture");
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      requests.push(`${request.method} ${pathname}`);
      if (pathname === "/oauth/token")
        return Response.json({ access_token: "fixture", expires_in: 3600 });
      return respond(request);
    },
  });
  try {
    await operate({
      file,
      requests,
      async cli(args, stdin = "") {
        const child = Bun.spawn([process.execPath, entrypoint, "--json", "vendors", ...args], {
          cwd: dir,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([key]) => !key.startsWith("VANTA_")),
            ),
            VANTA_CLIENT_ID: "fixture",
            VANTA_CLIENT_SECRET: "fixture",
            VANTA_BASE_URL: server.url.origin,
            VANTA_CONFIG_PATH: join(dir, "missing.json"),
            VANTA_TOKEN_CACHE_PATH: join(dir, "token.json"),
          },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        child.stdin.write(stdin);
        child.stdin.end();
        const timeout = setTimeout(() => child.kill(), 5000);
        try {
          const [code, out, err] = await Promise.all([
            child.exited,
            child.stdout.text(),
            child.stderr.text(),
          ]);
          return { code, out, err };
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

for (const nested of [false, true]) {
  test(`vendor ${nested ? "review " : ""}document upload verifies parents and multipart fields`, async () => {
    const path = nested ? `${review}/documents` : `${base}/documents`;
    let uploaded = false;
    await fixture(
      async ({ cli, file, requests }) => {
        const args = nested
          ? ["security-reviews", "documents", "upload", vendorId, reviewId]
          : ["documents", "upload", vendorId];
        const dry = await cli([
          ...args,
          "--file",
          file,
          "--type",
          "CUSTOM_TYPE",
          "--title",
          "Report=a",
          "--description",
          "Evidence",
        ]);
        expect(dry.code).toBe(0);
        expect(JSON.parse(dry.out).request.path).toBe(path);
        expect(requests).toEqual([]);
        const result = await cli([
          ...args,
          "--file",
          file,
          "--type",
          "CUSTOM_TYPE",
          "--title",
          "Report=a",
          "--description",
          "Evidence",
          "--apply",
          "--yes",
        ]);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.out)).toEqual({ id: "doc" });
        expect(uploaded).toBe(true);
        expect(requests).toEqual([
          "POST /oauth/token",
          `GET ${base}`,
          ...(nested ? [`GET ${review}`] : []),
          `POST ${path}`,
        ]);
      },
      async (request) => {
        const url = new URL(request.url);
        if (request.method === "GET")
          return Response.json(
            url.pathname === base ? { id: vendorId } : { id: reviewId, vendorId },
          );
        expect(url.pathname).toBe(path);
        const form = await request.formData();
        expect([...form.keys()].sort()).toEqual(["description", "file", "title", "type"]);
        expect(form.get("type")).toBe("CUSTOM_TYPE");
        expect(form.get("title")).toBe("Report=a");
        expect(form.get("description")).toBe("Evidence");
        const upload = form.get("file");
        if (!(upload instanceof File)) throw new Error("Missing file");
        expect(upload.name).toBe("evidence.pdf");
        expect(upload.type).toBe("application/pdf");
        expect(await upload.text()).toBe("%PDF-fixture");
        uploaded = true;
        return Response.json({ id: "doc" });
      },
    );
  });
}

for (const status of ["MANAGED", "ARCHIVED", "IN_PROCUREMENT"]) {
  test(`vendor status ${status} is text-only multipart`, async () => {
    await fixture(
      async ({ cli, requests }) => {
        const dry = await cli(["set-status", vendorId, "--status", status]);
        expect(dry.code).toBe(0);
        expect(requests).toEqual([]);
        const result = await cli(["set-status", vendorId, "--status", status, "--apply", "--yes"]);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.out)).toEqual({ id: vendorId, status });
        expect(requests.at(-1)).toBe(`POST ${base}/set-status`);
      },
      async (request) => {
        if (request.method === "GET")
          return Response.json({
            id: vendorId,
            status: status === "ARCHIVED" ? "MANAGED" : "ARCHIVED",
          });
        expect([...(await request.formData())]).toEqual([["status", status]]);
        return Response.json({ id: vendorId, status });
      },
    );
  });
}

test("already-target vendor status returns noChange without confirmation or write", async () => {
  await fixture(
    async ({ cli, requests }) => {
      const result = await cli(["set-status", vendorId, "--status", "MANAGED", "--apply"]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out)).toEqual({ noChange: true, vendorId, status: "MANAGED" });
      expect(requests).toEqual(["POST /oauth/token", `GET ${base}`]);
    },
    () => Response.json({ id: vendorId, status: "MANAGED" }),
  );
});

test("uploads require file and nonempty type; invalid status fails offline", async () => {
  await fixture(
    async ({ cli, file, requests }) => {
      for (const args of [
        ["documents", "upload", vendorId, "--type", "REPORT"],
        ["documents", "upload", vendorId, "--file", file],
        ["documents", "upload", vendorId, "--file", file, "--type", "  "],
        ["documents", "upload", vendorId, "--file", `${file}.missing`, "--type", "REPORT"],
        ["set-status", vendorId, "--status", "DELETED"],
      ])
        expect((await cli(args)).code).not.toBe(0);
      expect(requests).toEqual([]);
    },
    () => Response.json({}),
  );
});

test("apply checks missing vendors, mismatched IDs and cross-vendor reviews before uploads", async () => {
  for (const response of ["missing", "wrongVendor", "wrongReview", "wrongParent"]) {
    await fixture(
      async ({ cli, file, requests }) => {
        const result = await cli([
          "security-reviews",
          "documents",
          "upload",
          vendorId,
          reviewId,
          "--file",
          file,
          "--type",
          "REPORT",
          "--apply",
          "--yes",
        ]);
        expect(result.code).not.toBe(0);
        expect(requests.filter((request) => request.startsWith("POST /v1"))).toEqual([]);
      },
      (request) => {
        if (response === "missing") return Response.json({ error: "not found" }, { status: 404 });
        if (new URL(request.url).pathname === base)
          return Response.json({ id: response === "wrongVendor" ? "other" : vendorId });
        return Response.json({
          id: response === "wrongReview" ? "other" : reviewId,
          vendorId: response === "wrongParent" ? "other" : vendorId,
        });
      },
    );
  }
});

test("vendor mutations require confirmation after preflight", async () => {
  await fixture(
    async ({ cli, requests }) => {
      const result = await cli(["set-status", vendorId, "--status", "ARCHIVED", "--apply"], "no\n");
      expect(result.code).toBe(2);
      expect(result.err).toContain("Set vendor vendor/a status to ARCHIVED");
      expect(requests).toEqual(["POST /oauth/token", `GET ${base}`]);
      const accepted = await cli(
        ["set-status", vendorId, "--status", "ARCHIVED", "--apply"],
        "yes\n",
      );
      expect(accepted.code).toBe(0);
      expect(requests.at(-1)).toBe(`POST ${base}/set-status`);
    },
    (request) =>
      Response.json({ id: vendorId, status: request.method === "GET" ? "MANAGED" : "ARCHIVED" }),
  );
});

const collections = [
  { args: ["documents", "list", vendorId], path: `${base}/documents`, owned: false },
  { args: ["assessments", "list", vendorId], path: `${base}/assessments`, owned: true },
  { args: ["security-reviews", "list", vendorId], path: `${base}/security-reviews`, owned: true },
  {
    args: ["security-reviews", "documents", "list", vendorId, reviewId],
    path: `${review}/documents`,
    owned: false,
  },
];
for (const collection of collections) {
  test(`vendor bounded list ${collection.path}`, async () => {
    const data = [
      { id: "first", ...(collection.owned ? { vendorId } : {}) },
      { id: "second", ...(collection.owned ? { vendorId } : {}) },
    ];
    await fixture(
      async ({ cli }) => {
        const one = await cli([...collection.args, "--query", "pageSize=1"]);
        expect(one.code).toBe(0);
        expect(JSON.parse(one.out).results.data).toEqual([data[0]]);
        const all = await cli([
          ...collection.args,
          "--all",
          "--max-pages",
          "2",
          "--query",
          "pageSize=1",
          "--query",
          "statusMatchesAny=OPEN",
          "--query",
          "statusMatchesAny=CLOSED",
        ]);
        expect(all.code).toBe(0);
        expect(JSON.parse(all.out).results.data).toEqual(data);
        expect(JSON.parse(all.out).scan.pagesFetched).toBe(2);
        expect((await cli([...collection.args, "--all", "--max-pages", "1"])).code).not.toBe(0);
      },
      (request) => {
        const url = new URL(request.url);
        expect(url.pathname).toBe(collection.path);
        if (url.searchParams.has("statusMatchesAny")) {
          expect(url.searchParams.getAll("statusMatchesAny")).toEqual(["OPEN", "CLOSED"]);
          expect(url.searchParams.get("pageSize")).toBe("1");
        }
        const cursor = url.searchParams.get("pageCursor");
        return Response.json(page([data[cursor ? 1 : 0]], !cursor, cursor ? undefined : "next"));
      },
    );
  });
}

for (const kind of ["assessments", "security-reviews"]) {
  test(`vendor ${kind} get encodes IDs and validates owner and resource ID`, async () => {
    let response: unknown = { id: "item/a", vendorId };
    await fixture(
      async ({ cli, requests }) => {
        const args = [kind, "get", vendorId, "item/a"];
        expect((await cli(args)).code).toBe(0);
        expect(requests.at(-1)).toBe(`GET ${base}/${kind}/item%2Fa`);
        for (const invalid of [
          { id: "item/a", vendorId: "other" },
          { id: "other", vendorId },
          { id: "item/a" },
        ]) {
          response = invalid;
          expect((await cli(args)).code).not.toBe(0);
        }
        response = page([{ id: "item/a", vendorId: "other" }]);
        expect((await cli([kind, "list", vendorId])).code).not.toBe(0);
      },
      () => Response.json(response),
    );
  });
}

test("vendor API failures propagate with no success result", async () => {
  for (const status of [403, 404])
    await fixture(
      async ({ cli, file }) => {
        const result = await cli([
          "documents",
          "upload",
          vendorId,
          "--file",
          file,
          "--type",
          "REPORT",
          "--apply",
          "--yes",
        ]);
        expect(result.code).not.toBe(0);
        expect(result.out).toBe("");
        expect(JSON.parse(result.err).error.status).toBe(status);
      },
      (request) =>
        request.method === "GET" ? Response.json({ id: vendorId }) : Response.json({}, { status }),
    );
});

test("existing vendor create and update dry-runs retain their JSON contracts", async () => {
  await fixture(
    async ({ cli, requests }) => {
      for (const [args, method, path] of [
        [["create"], "POST", "/v1/vendors"],
        [["update", "vendor"], "PATCH", "/v1/vendors/vendor"],
      ] satisfies [string[], string, string][]) {
        const result = await cli([...args, "--body", '{"name":"Vendor"}']);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.out).request).toEqual({ method, path, body: { name: "Vendor" } });
      }
      expect(requests).toEqual([]);
    },
    () => Response.json({}),
  );
});

test("vendor status rejects HTTP 200 with wrong or missing returned status or ID", async () => {
  for (const result of [
    { id: vendorId, status: "MANAGED" },
    { id: vendorId },
    { id: "other", status: "ARCHIVED" },
  ]) {
    await fixture(
      async ({ cli }) => {
        const response = await cli([
          "set-status",
          vendorId,
          "--status",
          "ARCHIVED",
          "--apply",
          "--yes",
        ]);
        expect(response.code).not.toBe(0);
        expect(response.out).toBe("");
        expect(JSON.parse(response.err).error.type).toBe("CliError");
      },
      (request) =>
        Response.json(request.method === "GET" ? { id: vendorId, status: "MANAGED" } : result),
    );
  }
});
