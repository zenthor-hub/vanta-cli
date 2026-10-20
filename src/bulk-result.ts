import { z } from "zod";

import { CliError } from "./errors.ts";

const bulkResultSchema = z.object({
  results: z
    .array(
      z.discriminatedUnion("status", [
        z.object({ id: z.string(), status: z.literal("SUCCESS") }),
        z.object({ id: z.string(), status: z.literal("ERROR"), message: z.string() }),
      ]),
    )
    .length(1),
});

export function assertSingleTargetBulkResult(response: unknown, requestedId: string) {
  const parsed = bulkResultSchema.safeParse(response);
  if (!parsed.success) {
    throw new CliError("Malformed bulk response. Expected exactly one SUCCESS or ERROR result.");
  }
  const [result] = parsed.data.results;
  if (result?.id !== requestedId) {
    throw new CliError("Bulk response did not match the requested ID.");
  }
  if (result.status === "ERROR") {
    const error = new CliError(
      `Update for ${requestedId} returned ERROR. The server message was redacted.`,
    );
    error.name = "BulkUpdateError";
    throw error;
  }
  return result;
}
