import { z } from "zod";

import type { VantaClient } from "./api.ts";
import { CliError } from "./errors.ts";

const dateTimeSchema = z.iso.datetime({ offset: true });
const RFC3339_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const personIdentitySchema = z.object({
  id: z.string(),
  name: z.object({ display: z.string() }),
});
const offboardingStateSchema = personIdentitySchema.extend({
  employment: z.object({
    status: z.enum(["UPCOMING", "CURRENT", "ON_LEAVE", "INACTIVE", "FORMER"]),
    startDate: dateTimeSchema,
    endDate: dateTimeSchema.nullable(),
  }),
  tasksSummary: z.object({
    details: z.object({
      completeOffboardingCustomTasks: z.object({
        status: z.enum(["COMPLETE", "DUE_SOON", "OVERDUE", "NONE"]),
        incompleteCustomOffboardingTasks: z.array(z.object({ name: z.string() })),
      }),
    }),
  }),
});

export function personnelId(value: string, label = "Person ID"): string {
  const trimmed = value.trim();
  if (!trimmed) throw new CliError(`${label} must not be empty.`);
  return trimmed;
}

function dateTime(value: string, label: string): string {
  if (!RFC3339_SECONDS.test(value) || !dateTimeSchema.safeParse(value).success) {
    throw new CliError(`${label} must be an RFC 3339 date-time with seconds and a timezone.`);
  }
  return value;
}

export function personnelUpdate(options: {
  firstName?: string;
  lastName?: string;
  employmentStartDate?: string;
}) {
  if ((options.firstName === undefined) !== (options.lastName === undefined)) {
    throw new CliError("Supply both --first-name and --last-name.");
  }
  if (options.firstName === undefined && options.employmentStartDate === undefined) {
    throw new CliError("Supply a name pair or --employment-start-date.");
  }
  return {
    ...(options.firstName !== undefined && options.lastName !== undefined
      ? {
          name: {
            first: personnelId(options.firstName, "--first-name"),
            last: personnelId(options.lastName, "--last-name"),
          },
        }
      : {}),
    ...(options.employmentStartDate === undefined
      ? {}
      : {
          employment: {
            startDate: dateTime(options.employmentStartDate, "--employment-start-date"),
          },
        }),
  };
}

export function personnelLeave(options: {
  startDate: string;
  endDate?: string;
  indefinite?: boolean;
}) {
  if ((options.endDate !== undefined) === Boolean(options.indefinite)) {
    throw new CliError("Supply exactly one of --end-date or --indefinite.");
  }
  const startDate = dateTime(options.startDate, "--start-date");
  const endDate = options.endDate === undefined ? null : dateTime(options.endDate, "--end-date");
  if (endDate !== null && Date.parse(endDate) < Date.parse(startDate)) {
    throw new CliError("--end-date must not be before --start-date.");
  }
  return { startDate, endDate };
}

export function assertPersonIdentity(response: unknown, id: string) {
  const parsed = personIdentitySchema.safeParse(response);
  if (!parsed.success || parsed.data.id !== id) {
    throw new CliError("Person response returned a mismatched ID or missing identity.");
  }
  return parsed.data;
}

export async function readPerson(client: Pick<VantaClient, "request">, id: string) {
  const response = await client.request({ path: `/v1/people/${encodeURIComponent(id)}` });
  assertPersonIdentity(response, id);
  return response;
}

export function offboardingObservation(response: unknown, id: string) {
  const parsed = offboardingStateSchema.safeParse(response);
  if (!parsed.success || parsed.data.id !== id) {
    throw new CliError("Person read returned a mismatched ID or missing offboarding state.");
  }
  const target = parsed.data;
  const tasks = target.tasksSummary.details.completeOffboardingCustomTasks;
  if (["CURRENT", "UPCOMING", "ON_LEAVE"].includes(target.employment.status)) {
    throw new CliError(
      `Person ${id} has employment status ${target.employment.status}. Offboarding completion requires an ex-employee.`,
    );
  }
  if (
    tasks.incompleteCustomOffboardingTasks.length > 0 ||
    tasks.status === "OVERDUE" ||
    tasks.status === "DUE_SOON"
  ) {
    throw new CliError(
      `Person ${id} has unfinished custom offboarding tasks (${tasks.status}). Complete them in Vanta before retrying.`,
    );
  }
  return {
    target: { id: target.id, name: target.name.display },
    employment: target.employment,
    customOffboardingTasks: tasks,
    eligibility:
      "Apply-time observations only. Monitored-account eligibility is not fully exposed by Person. Vanta validates remaining prerequisites.",
  };
}
