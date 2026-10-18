import type { RequestOptions } from "./api.ts";
import { CliError } from "./errors.ts";
import { PaginationGuard } from "./pagination.ts";

export const CODE_CHANGE_SOURCES = ["github", "gitlab", "bitbucket", "azuredevops"] as const;
export type CodeChangeSource = (typeof CODE_CHANGE_SOURCES)[number];

export type CodeChange = {
  id: string;
  codeChange: string;
  identifier?: string;
  service?: string;
  repository?: string;
  openedAt?: string;
  closedAt?: string;
};

export type CodeChangesResponse = {
  results: {
    data: CodeChange[];
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  };
  scan?: {
    mode: "repository-filter-all-pages" | "all-pages";
    repository?: string;
    pagesFetched: number;
    complete: true;
  };
};

export type AuditorClient = {
  request(options: RequestOptions): Promise<CodeChangesResponse>;
};

export type CodeChangeListOptions = {
  search?: string;
  sources: CodeChangeSource[];
  closedAfterDate?: string;
  closedBeforeDate?: string;
  pageSize?: number;
  pageCursor?: string;
  repository?: string;
  maxPages?: number;
  all?: boolean;
};

const RFC3339_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function auditCodeChangesPath(auditId: string): string {
  return `/v1/audits/${encodeURIComponent(auditId)}/assets/code-changes`;
}

export function parseCodeChangeSources(values: string[]): CodeChangeSource[] {
  const normalized = values.map((value) => value.toLowerCase());
  const invalid = normalized.filter(
    (value) => !CODE_CHANGE_SOURCES.includes(value as CodeChangeSource),
  );
  if (invalid.length > 0) {
    throw new CliError(
      `Invalid code-change source: ${invalid.join(", ")}. Use github, gitlab, bitbucket, or azuredevops.`,
    );
  }
  return [...new Set(normalized)] as CodeChangeSource[];
}

export function parseCodeChangePageSize(value?: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new CliError("--page-size must be an integer from 1 to 100.");
  const pageSize = Number(value);
  if (pageSize < 1 || pageSize > 100) {
    throw new CliError("--page-size must be an integer from 1 to 100.");
  }
  return pageSize;
}

export function parseCodeChangeMaxPages(value?: string): number {
  if (value === undefined) return 50;
  if (!/^\d+$/.test(value)) throw new CliError("--max-pages must be an integer from 1 to 100.");
  const maxPages = Number(value);
  if (maxPages < 1 || maxPages > 100) {
    throw new CliError("--max-pages must be an integer from 1 to 100.");
  }
  return maxPages;
}

export function parseCodeChangeDate(
  value: string | undefined,
  optionName: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (!RFC3339_DATE_TIME.test(value) || Number.isNaN(Date.parse(value))) {
    throw new CliError(
      `${optionName} must be an RFC 3339 date-time, for example 2026-12-31T23:59:59Z.`,
    );
  }
  return value;
}

export function parseCodeChangeRepository(value?: string): string | undefined {
  if (value === undefined) return undefined;
  const repository = value.trim();
  if (!repository) throw new CliError("--repository must not be empty.");
  return repository;
}

export function filterCodeChangesByRepository(
  response: CodeChangesResponse,
  repository?: string,
): CodeChangesResponse {
  if (repository === undefined) return response;
  return {
    ...response,
    results: {
      ...response.results,
      data: response.results.data.filter((codeChange) => codeChange.repository === repository),
    },
  };
}

export async function listAuditCodeChanges(
  client: AuditorClient,
  auditId: string,
  options: CodeChangeListOptions,
): Promise<CodeChangesResponse> {
  const repository = parseCodeChangeRepository(options.repository);
  const request = (pageCursor: string | undefined) =>
    client.request({
      path: auditCodeChangesPath(auditId),
      query: {
        search: options.search,
        sourcesMatchesAny: options.sources.length > 0 ? options.sources : undefined,
        closedAfterDate: options.closedAfterDate,
        closedBeforeDate: options.closedBeforeDate,
        pageSize: options.pageSize?.toString(),
        pageCursor,
      },
    });

  if (repository === undefined && !options.all) return request(options.pageCursor);

  const pagination = new PaginationGuard(
    `Audit ${auditId} code-change pagination`,
    options.maxPages ?? 50,
  );
  pagination.rememberCursor(options.pageCursor);
  let pageCursor = options.pageCursor;
  const data: CodeChange[] = [];
  do {
    pagination.startPage();
    const response = await request(pageCursor);
    data.push(...filterCodeChangesByRepository(response, repository).results.data);
    pageCursor = pagination.nextCursor(response.results.pageInfo);
  } while (pageCursor);

  return {
    results: {
      data,
      pageInfo: { hasNextPage: false },
    },
    scan: {
      mode: repository === undefined ? "all-pages" : "repository-filter-all-pages",
      ...(repository === undefined ? {} : { repository }),
      pagesFetched: pagination.pagesFetched(),
      complete: true,
    },
  };
}
