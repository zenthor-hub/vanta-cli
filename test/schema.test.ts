import { expect, test } from "bun:test";
import { validateContract } from "../scripts/validate-api-paths.ts";

const contract = {
  api: "manage" as const,
  path: "/controls/{controlId}/set-owner",
  method: "post",
  query: ["pageSize"],
  body: { contentType: "application/json", fields: { userId: "string" }, supplied: ["userId"] },
};

function spec() {
  return {
    paths: {
      [contract.path]: {
        post: {
          parameters: [{ in: "query", name: "pageSize" }],
          requestBody: {
            content: { "application/json": { schema: { $ref: "#/components/schemas/Owner" } } },
          },
        },
      },
    },
    components: {
      schemas: {
        Owner: { type: "object", properties: { userId: { type: "string" } }, required: ["userId"] },
      },
    },
  };
}

test("schema check resolves body references and validates methods, queries and fields", () => {
  expect(() => validateContract(spec(), contract)).not.toThrow();
  expect(() => validateContract(spec(), { ...contract, method: "patch" })).toThrow();
  expect(() => validateContract(spec(), { ...contract, query: ["unsupported"] })).toThrow(
    "Missing query",
  );
  expect(() =>
    validateContract(spec(), {
      ...contract,
      body: { ...contract.body, fields: { ownerId: "string" } },
    }),
  ).toThrow();
  const changedType = spec();
  changedType.components.schemas.Owner.properties.userId.type = "number";
  expect(() => validateContract(changedType, contract)).toThrow("changed body field");
  const addedRequired = spec();
  addedRequired.components.schemas.Owner.required.push("newRequiredField");
  expect(() => validateContract(addedRequired, contract)).toThrow(
    "does not supply required body field",
  );
});

test("coverage separates curated endpoints, supported raw transports and Auditor routing", async () => {
  const { coverageReport } = await import("../scripts/validate-api-paths.ts");
  const reportSpec = {
    paths: {
      "/issues": { get: {} },
      "/other": { post: { requestBody: { content: { "application/json": {} } } } },
      "/upload": { post: { requestBody: { content: { "multipart/form-data": {} } } } },
      "/download": { get: { responses: { "200": { content: { "application/pdf": {} } } } } },
    },
  };
  expect(coverageReport(reportSpec, "manage").counts).toEqual({
    curated: 1,
    raw: 3,
    "unsupported-api": 0,
    "unsupported-transport": 0,
  });
  expect(coverageReport(reportSpec, "auditor").counts).toEqual({
    curated: 0,
    raw: 1,
    "unsupported-api": 3,
    "unsupported-transport": 0,
  });
});

test("personnel workflow coverage includes the four curated mutations", async () => {
  const { coverageReport, CURATED_OPERATIONS } = await import("../scripts/validate-api-paths.ts");
  const expected = [
    ["patch", "/people/{personId}"],
    ["post", "/people/{personId}/set-leave"],
    ["post", "/people/{personId}/clear-leave"],
    ["post", "/people/offboard"],
  ];
  for (const [method, path] of expected) {
    expect(
      CURATED_OPERATIONS.some(
        (operation) =>
          operation.api === "manage" && operation.method === method && operation.path === path,
      ),
    ).toBe(true);
  }
  expect(
    coverageReport(
      {
        paths: {
          "/people/{personId}": { patch: {} },
          "/people/{personId}/set-leave": { post: {} },
          "/people/{personId}/clear-leave": { post: {} },
          "/people/offboard": { post: {} },
        },
      },
      "manage",
    ).counts.curated,
  ).toBe(4);
});
