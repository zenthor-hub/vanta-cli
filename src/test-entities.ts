import type { RequestOptions } from "./api.ts";
import { CliError } from "./errors.ts";
import { PaginationGuard } from "./pagination.ts";

export type EntityStatus = "FAILING" | "DEACTIVATED";

export type TestEntity = {
  id: string;
  entityStatus: EntityStatus;
  displayName: string;
  responseType: string;
  deactivatedReason: string | null;
  lastUpdatedDate: string;
  createdDate: string;
};

type TestEntitiesResponse = {
  results: {
    data: TestEntity[];
    pageInfo: {
      hasNextPage: boolean;
      endCursor?: string | null;
    };
  };
};

export type TestEntitiesClient = {
  request(options: RequestOptions): Promise<TestEntitiesResponse>;
};

const RFC3339_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function testEntitiesPath(testId: string): string {
  return `/v1/tests/${encodeURIComponent(testId)}/entities`;
}

export function testEntityActionPath(
  testId: string,
  entityId: string,
  action: "deactivate" | "reactivate",
): string {
  return `${testEntitiesPath(testId)}/${encodeURIComponent(entityId)}/${action}`;
}

export function parseEntityStatus(value: string): EntityStatus {
  const normalized = value.toUpperCase();
  if (normalized === "FAILING" || normalized === "DEACTIVATED") return normalized;
  throw new CliError("Entity status must be failing or deactivated.");
}

export function parseEntityPageSize(value?: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new CliError("--page-size must be an integer from 1 to 100.");
  const pageSize = Number(value);
  if (pageSize < 1 || pageSize > 100) {
    throw new CliError("--page-size must be an integer from 1 to 100.");
  }
  return pageSize;
}

export function deactivateEntityBody(
  reason: string,
  until?: string,
): {
  deactivateReason: string;
  deactivateUntilDate?: string;
} {
  const deactivateReason = reason.trim();
  if (!deactivateReason) throw new CliError("--reason must not be empty.");
  if (until !== undefined && (!RFC3339_DATE_TIME.test(until) || Number.isNaN(Date.parse(until)))) {
    throw new CliError("--until must be an RFC 3339 date-time, for example 2026-12-31T23:59:59Z.");
  }
  return until === undefined
    ? { deactivateReason }
    : { deactivateReason, deactivateUntilDate: until };
}

export async function findTestEntity(
  client: TestEntitiesClient,
  testId: string,
  entityId: string,
  entityStatus: EntityStatus,
): Promise<TestEntity> {
  let pageCursor: string | undefined;
  const pagination = new PaginationGuard(`Test ${testId} entity pagination`);
  do {
    pagination.startPage();
    const response = await client.request({
      path: testEntitiesPath(testId),
      query: { entityStatus, pageSize: "100", pageCursor },
    });
    const entity = response.results.data.find((item) => item.id === entityId);
    if (entity) return entity;
    pageCursor = pagination.nextCursor(response.results.pageInfo);
  } while (pageCursor !== undefined);

  throw new CliError(
    `Test entity ${entityId} was not found in ${entityStatus.toLowerCase()} entities for test ${testId}.`,
  );
}
