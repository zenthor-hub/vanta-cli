import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const entrypoint = resolve(import.meta.dir, "../src/vanta.ts");
const pdf = new Uint8Array([37, 80, 68, 70, 45, 255, 0, 10]);

async function fixture(
  operate: (context: {
    dir: string;
    file: string;
    requests: Request[];
    cli: (
      args: string[],
      stdin?: string,
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  }) => Promise<void>,
  respond: (request: Request) => Response | Promise<Response> = () =>
    Response.json({ accepted: true }),
) {
  const dir = mkdtempSync(join(tmpdir(), "vanta-transfer-"));
  const file = join(dir, "evidence.pdf");
  writeFileSync(file, pdf);
  const requests: Request[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push(request);
      if (new URL(request.url).pathname === "/oauth/token") {
        return Response.json({ access_token: "synthetic-token", expires_in: 3600 });
      }
      return respond(request);
    },
  });
  try {
    await operate({
      dir,
      file,
      requests,
      async cli(args, stdin = "") {
        const child = Bun.spawn([process.execPath, entrypoint, "--json", ...args], {
          cwd: dir,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([key]) => !key.startsWith("VANTA_")),
            ),
            VANTA_CLIENT_ID: "synthetic-client",
            VANTA_CLIENT_SECRET: "synthetic-secret",
            VANTA_BASE_URL: server.url.origin,
            VANTA_TOKEN_CACHE_PATH: join(dir, "token.json"),
            VANTA_CONFIG_PATH: join(dir, "missing.json"),
          },
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

const uploads = [
  { path: "/v1/contracts", fileField: "file", fields: {} },
  {
    path: "/v1/customer-trust/questionnaires/file",
    fileField: "file",
    fields: { displayName: "Questionnaire=a" },
  },
  {
    path: "/v1/knowledge-base/resources/documents",
    fileField: "file",
    fields: { title: "Title=a" },
  },
  { path: "/v1/knowledge-base/resources/documents/doc%2Fa/upload", fileField: "file", fields: {} },
  {
    path: "/v1/trust-centers/slug%2Fa/compliance-frameworks/framework%2Fa/badge",
    fileField: "file",
    fields: {},
  },
  { path: "/v1/trust-centers/slug%2Fa/favicon", fileField: "favicon", fields: {} },
  {
    path: "/v1/trust-centers/slug%2Fa/resources",
    fileField: "file",
    fields: { title: "Title=a", isPublic: "true" },
  },
  { path: "/v1/vendors/vendor%2Fa/documents", fileField: "file", fields: { type: "SOC2_REPORT" } },
  {
    path: "/v1/vendors/vendor%2Fa/security-reviews/review%2Fa/documents",
    fileField: "file",
    fields: { type: "SOC2_REPORT" },
  },
];

for (const operation of uploads) {
  test(`raw multipart fixture ${operation.path}`, async () => {
    let inspected = false;
    await fixture(
      async ({ file, cli }) => {
        const fields = Object.entries(operation.fields).flatMap(([name, value]) => [
          "--form",
          `${name}=${value}`,
        ]);
        const result = await cli([
          "raw",
          "POST",
          operation.path,
          "--file",
          `${operation.fileField}=${file}`,
          ...fields,
          "--apply",
          "--yes",
        ]);
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ accepted: true });
        expect(inspected).toBe(true);
      },
      async (request) => {
        expect(request.method).toBe("POST");
        expect(new URL(request.url).pathname).toBe(operation.path);
        const form = await request.formData();
        expect([...form.keys()].sort()).toEqual(
          [operation.fileField, ...Object.keys(operation.fields)].sort(),
        );
        for (const [name, value] of Object.entries(operation.fields))
          expect(form.get(name)).toBe(value);
        const file = form.get(operation.fileField);
        expect(file instanceof File).toBe(true);
        if (!(file instanceof File)) throw new Error("Missing file");
        expect(file.name).toBe("evidence.pdf");
        expect(file.type).toBe("application/pdf");
        expect(new Uint8Array(await file.arrayBuffer())).toEqual(pdf);
        inspected = true;
        return Response.json({ accepted: true });
      },
    );
  });
}

test("raw text-only multipart supports vendor status and opaque JSON field values", async () => {
  await fixture(
    async ({ cli }) => {
      const result = await cli([
        "raw",
        "POST",
        "/v1/vendors/vendor%2Fa/set-status",
        "--form",
        "status=MANAGED",
        "--form",
        'metadata={"key":"value=1"}',
        "--form",
        "empty=",
        "--apply",
        "--yes",
      ]);
      expect(result.exitCode).toBe(0);
    },
    async (request) => {
      expect(new URL(request.url).pathname).toBe("/v1/vendors/vendor%2Fa/set-status");
      expect(request.method).toBe("POST");
      const form = await request.formData();
      expect([...form.entries()]).toEqual([
        ["status", "MANAGED"],
        ["metadata", '{"key":"value=1"}'],
        ["empty", ""],
      ]);
      return Response.json({ accepted: true });
    },
  );
});

test("raw upload dry-run reports only file metadata and sends no token or API request", async () => {
  await fixture(async ({ cli, file, requests }) => {
    const result = await cli([
      "raw",
      "PATCH",
      "/v1/upload",
      "--file",
      `file=${file}`,
      "--file-type",
      "file=application/custom",
    ]);
    expect(result.exitCode).toBe(0);
    expect(requests).toHaveLength(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      request: {
        parts: [
          {
            kind: "file",
            path: file,
            filename: basename(file),
            contentType: "application/custom",
            size: pdf.byteLength,
          },
        ],
      },
    });
    expect(result.stdout).not.toContain("%PDF");
  });
});

test("raw rejects incompatible options and malformed multipart before requests", async () => {
  await fixture(async ({ cli, file, dir, requests }) => {
    const cases = [
      ["POST", "--form", "a=b", "--body", "{}"],
      ["POST", "--body", "{}", "--body-file", file],
      ["GET", "--form", "a=b"],
      ["DELETE", "--file", `file=${file}`],
      ["POST", "--output", join(dir, "out")],
      ["GET", "--force"],
      ["GET", "--output", join(dir, "out"), "--body", "{}"],
      ["POST", "--form", "a=1", "--form", "a=2"],
      ["POST", "--form", "file=a", "--file", `file=${file}`],
      ["POST", "--form", "=a"],
      ["POST", "--file", "file=/missing/path"],
      ["POST", "--file", `file=${dir}`],
      ["POST", "--file-type", "file=text/plain"],
      ["POST", "--file", `file=${file}`, "--file-type", "other=text/plain"],
      ["POST", "--file", `file=${file}`, "--file-type", "file=invalid"],
    ];
    for (const [method, ...args] of cases) {
      const result = await cli(["raw", method ?? "POST", "/v1/example", ...args]);
      expect(result.exitCode).not.toBe(0);
      expect(JSON.parse(result.stderr)).toMatchObject({ ok: false });
    }
    expect(requests).toHaveLength(0);
  });
});

for (const contentType of ["application/octet-stream", "application/json", "text/plain"]) {
  test(`raw media download preserves exact ${contentType} bytes`, async () => {
    const bytes = new Uint8Array([123, 34, 255, 0, 10, 125]);
    await fixture(
      async ({ cli, dir }) => {
        const output = join(dir, "result.bin");
        const result = await cli([
          "raw",
          "GET",
          "/v1/trust-centers/slug%2Fa/resources/resource%2Fa/media",
          "--query",
          "key=value=1",
          "--output",
          output,
        ]);
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ outputPath: output, bytes: bytes.byteLength });
        expect(new Uint8Array(readFileSync(output))).toEqual(bytes);
        expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      },
      (request) => {
        expect(request.headers.get("accept")).not.toBe("application/json");
        expect(new URL(request.url).pathname).toBe(
          "/v1/trust-centers/slug%2Fa/resources/resource%2Fa/media",
        );
        expect(new URL(request.url).searchParams.get("key")).toBe("value=1");
        return new Response(bytes, { headers: { "content-type": contentType } });
      },
    );
  });
}

test("raw and document output reject existing files and atomically replace only with force", async () => {
  await fixture(
    async ({ cli, dir, requests }) => {
      const output = join(dir, "result.bin");
      writeFileSync(output, "original");
      for (const args of [
        ["raw", "GET", "/v1/file"],
        ["documents", "download", "doc/a", "upload/a"],
      ]) {
        const refused = await cli([...args, "--output", output]);
        expect(refused.exitCode).not.toBe(0);
        expect(readFileSync(output, "utf8")).toBe("original");
        expect(requests).toHaveLength(0);
      }
      const result = await cli([
        "documents",
        "download",
        "doc/a",
        "upload/a",
        "--output",
        output,
        "--force",
      ]);
      expect(result.exitCode).toBe(0);
      expect(readFileSync(output, "utf8")).toBe("replacement");
      expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
    (request) => {
      expect(new URL(request.url).pathname).toBe("/v1/documents/doc%2Fa/uploads/upload%2Fa/media");
      return new Response("replacement");
    },
  );
});

test("download publication never clobbers a destination created during transfer", async () => {
  let output = "";
  await fixture(
    async ({ cli, dir }) => {
      output = join(dir, "race.bin");
      const result = await cli(["raw", "GET", "/v1/file", "--output", output]);
      expect(result.exitCode).not.toBe(0);
      expect(readFileSync(output, "utf8")).toBe("concurrent writer");
      expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
    () => {
      writeFileSync(output, "concurrent writer");
      return new Response("response");
    },
  );
});

test("failed transfer with force preserves the existing destination", async () => {
  await fixture(
    async ({ cli, dir }) => {
      const output = join(dir, "old.bin");
      writeFileSync(output, "original");
      const result = await cli(["raw", "GET", "/v1/file", "--output", output, "--force"]);
      expect(result.exitCode).not.toBe(0);
      expect(readFileSync(output, "utf8")).toBe("original");
      expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
    () => Response.json({ message: "synthetic failure" }, { status: 503 }),
  );
});

test("multipart PUT preserves multiple files, MIME override, and unknown extension fallback", async () => {
  let inspected = false;
  await fixture(
    async ({ cli, dir, file }) => {
      const unknown = join(dir, "unknown.extension");
      writeFileSync(unknown, "opaque");
      const result = await cli([
        "raw",
        "PUT",
        "/v1/files",
        "--file",
        `one=${file}`,
        "--file",
        `two=${unknown}`,
        "--file-type",
        "one=application/custom",
        "--apply",
        "--yes",
      ]);
      expect(result.exitCode).toBe(0);
      expect(inspected).toBe(true);
    },
    async (request) => {
      expect(request.method).toBe("PUT");
      const wire = await request.clone().text();
      expect(wire).toContain("Content-Type: application/custom");
      expect(wire).toContain("Content-Type: application/octet-stream");
      const parts = await request.formData();
      const one = parts.get("one"),
        two = parts.get("two");
      if (!(one instanceof File) || !(two instanceof File)) throw new Error("Missing files");
      expect(one.name).toBe("evidence.pdf");
      expect(two.name).toBe("unknown.extension");
      expect(await two.text()).toBe("opaque");
      inspected = true;
      return Response.json({ accepted: true });
    },
  );
});

test("raw force output replaces a file and multipart abort sends no request", async () => {
  await fixture(
    async ({ cli, dir, file, requests }) => {
      const aborted = await cli(
        ["raw", "POST", "/v1/upload", "--file", `file=${file}`, "--apply"],
        "no\n",
      );
      expect(aborted.exitCode).toBe(2);
      expect(requests).toHaveLength(0);
      const output = join(dir, "old.bin");
      writeFileSync(output, "original");
      const result = await cli(["raw", "GET", "/v1/file", "--output", output, "--force"]);
      expect(result.exitCode).toBe(0);
      expect(readFileSync(output, "utf8")).toBe("replacement");
    },
    () => new Response("replacement"),
  );
});
