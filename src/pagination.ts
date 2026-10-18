import { CliError } from "./errors.ts";
import type { RequestOptions, VantaClient } from "./api.ts";

export type PageInfo = {
  hasNextPage: boolean;
  endCursor?: string | null;
};

export type Page<T> = {
  results: { data: T[]; pageInfo: PageInfo };
};

export const DEFAULT_REQUEST_ALL_MAX_PAGES = 100;

export function parseMaxPages(value = "100"): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) {
    throw new CliError("--max-pages must be an integer from 1 to 100.");
  }
  return Number(value);
}

export async function requestAllPages<T>(
  client: Pick<VantaClient, "request">,
  path: string,
  query: RequestOptions["query"] = {},
  options: { maxPages?: number; pageSize?: number } = {},
): Promise<Page<T> & { scan: { pagesFetched: number; complete: true } }> {
  if (Array.isArray(query.pageCursor)) throw new CliError("Use only one pageCursor.");
  const pagination = new PaginationGuard(path, options.maxPages);
  let pageCursor = query.pageCursor;
  pagination.rememberCursor(pageCursor);
  const data: T[] = [];
  do {
    pagination.startPage();
    const page = await client.request<Page<T>>({
      path,
      query: { ...query, pageSize: query.pageSize ?? String(options.pageSize ?? 100), pageCursor },
    });
    data.push(...page.results.data);
    pageCursor = pagination.nextCursor(page.results.pageInfo);
  } while (pageCursor !== undefined);
  return {
    results: { data, pageInfo: { hasNextPage: false } },
    scan: { pagesFetched: pagination.pagesFetched(), complete: true },
  };
}

export async function requestAll<T>(
  client: Pick<VantaClient, "request">,
  path: string,
  query: RequestOptions["query"] = {},
  options: { maxPages?: number; pageSize?: number } = {},
): Promise<T[]> {
  return (await requestAllPages<T>(client, path, query, options)).results.data;
}

export class PaginationGuard {
  private readonly context: string;
  private readonly maxPages: number;
  private readonly seenCursors = new Set<string>();
  private pageCount = 0;

  public constructor(context: string, maxPages = DEFAULT_REQUEST_ALL_MAX_PAGES) {
    this.context = context;
    this.maxPages = maxPages;
  }

  public startPage(): void {
    this.pageCount += 1;
    if (this.pageCount > this.maxPages) {
      throw new CliError(
        `${this.context} exceeded the ${this.maxPages}-page safety limit. Narrow the query or increase the explicit page bound.`,
      );
    }
  }

  public rememberCursor(cursor?: string): void {
    if (cursor) this.seenCursors.add(cursor);
  }

  public nextCursor(pageInfo: PageInfo): string | undefined {
    if (!pageInfo.hasNextPage) return undefined;
    const cursor = pageInfo.endCursor?.trim();
    if (!cursor) {
      throw new CliError(`${this.context} reported another page without an end cursor.`);
    }
    if (this.seenCursors.has(cursor)) {
      throw new CliError(`${this.context} repeated pagination cursor ${cursor}.`);
    }
    this.seenCursors.add(cursor);
    return cursor;
  }

  public pagesFetched(): number {
    return this.pageCount;
  }
}
