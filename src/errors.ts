export class CliError extends Error {
  public readonly exitCode: number;

  public constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export class VantaApiError extends Error {
  public readonly status: number;
  public readonly body: unknown;
  public readonly api: "manage" | "auditor";

  public constructor(
    status: number,
    body: unknown,
    message?: string,
    api: "manage" | "auditor" = "manage",
  ) {
    super(message ?? `Vanta API request failed with status ${status}`);
    this.name = "VantaApiError";
    this.status = status;
    this.body = body;
    this.api = api;
  }
}

export function formatError(error: unknown): string {
  if (error instanceof VantaApiError) {
    const body = typeof error.body === "string" ? error.body : JSON.stringify(error.body, null, 2);
    const guidance = guidanceForStatus(error.status, body, error.api);
    return [
      `Vanta API error ${error.status}: ${error.message}`,
      body ? `Response:\n${body}` : undefined,
      guidance,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  if (error instanceof CliError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function formatJsonError(error: unknown): {
  ok: false;
  error: {
    type: string;
    message: string;
    status?: number;
    guidance?: string;
  };
} {
  if (error instanceof VantaApiError) {
    const body = typeof error.body === "string" ? error.body : JSON.stringify(error.body);
    return {
      ok: false,
      error: {
        type: error.name,
        message: error.message,
        status: error.status,
        guidance: guidanceForStatus(error.status, body, error.api),
      },
    };
  }
  if (error instanceof Error) {
    return {
      ok: false,
      error: { type: error.name, message: error.message },
    };
  }
  return {
    ok: false,
    error: { type: "UnknownError", message: String(error) },
  };
}

function guidanceForStatus(
  status: number,
  body: string | undefined,
  api: "manage" | "auditor",
): string | undefined {
  if (api === "auditor") {
    if (status === 401)
      return "Retry guidance: check VANTA_AUDITOR_CLIENT_ID, VANTA_AUDITOR_CLIENT_SECRET, and the separate Auditor token cache.";
    if (status === 403)
      return "Retry guidance: check the Auditor application's permissions and VANTA_AUDITOR_SCOPE (auditor-api.audit:read).";
    if (status === 429)
      return "Retry guidance: Vanta rate limits Auditor API calls. Wait before retrying and avoid parallel token minting.";
    return undefined;
  }
  const normalized = body?.toLowerCase() ?? "";
  if (status === 401) {
    return "Retry guidance: check VANTA_CLIENT_ID, VANTA_CLIENT_SECRET, token cache expiry, and whether another process minted a newer token for the same Vanta app.";
  }
  if (status === 429) {
    return "Retry guidance: Vanta rate limits token calls and Manage API calls. Wait before retrying and avoid parallel token minting.";
  }
  if (status === 403 || normalized.includes("scope")) {
    return "Retry guidance: the configured VANTA_SCOPE may not permit this operation. Use an appropriate write or upload scope for mutating commands.";
  }
  return undefined;
}
