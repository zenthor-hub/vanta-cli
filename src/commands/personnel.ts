import { Command } from "commander";

import type { RequestOptions, VantaClient } from "../api.ts";
import { assertSingleTargetBulkResult } from "../bulk-result.ts";
import { run } from "../cli-run.ts";
import { confirmWrite } from "../io.ts";
import {
  assertPersonIdentity,
  offboardingObservation,
  personnelId,
  personnelLeave,
  personnelUpdate,
  readPerson,
} from "../personnel.ts";

type MutationPlan = {
  id: string;
  summary: string;
  request: RequestOptions;
} & ({ kind: "person" } | { kind: "offboard"; acknowledgerId: string });

export function registerPersonnelCommands(personnel: Command): void {
  personnel
    .command("update")
    .description("Update a paired first/last name and/or employment start date")
    .argument("<id>")
    .option("--first-name <name>", "first name; requires --last-name")
    .option("--last-name <name>", "last name; requires --first-name")
    .option("--employment-start-date <date-time>", "RFC 3339 employment start date")
    .action(async function (
      this: Command,
      id: string,
      options: Parameters<typeof personnelUpdate>[0],
    ) {
      await mutate(this, () => {
        id = personnelId(id);
        const body = personnelUpdate(options);
        return {
          kind: "person",
          id,
          summary: `Update personnel ${id}. Changes: ${JSON.stringify(body)}.`,
          request: { method: "PATCH", path: `/v1/people/${encodeURIComponent(id)}`, body },
        };
      });
    });

  personnel
    .command("set-leave")
    .description("Replace existing leave; require an end date or explicit indefinite leave")
    .argument("<id>")
    .requiredOption("--start-date <date-time>", "RFC 3339 leave start date")
    .option("--end-date <date-time>", "RFC 3339 leave end date; cannot combine with --indefinite")
    .option("--indefinite", "send an explicit null end date")
    .action(async function (
      this: Command,
      id: string,
      options: Parameters<typeof personnelLeave>[0],
    ) {
      await mutate(this, () => {
        id = personnelId(id);
        const body = personnelLeave(options);
        return {
          kind: "person",
          id,
          summary: `Replace leave for personnel ${id}. ${JSON.stringify(body)}. While on leave, the person is inactive in certain personnel-related tests.`,
          request: { method: "POST", path: `/v1/people/${encodeURIComponent(id)}/set-leave`, body },
        };
      });
    });

  personnel
    .command("clear-leave")
    .description("Clear leave so the person becomes active in personnel-related tests")
    .argument("<id>")
    .action(async function (this: Command, id: string) {
      await mutate(this, () => {
        id = personnelId(id);
        return {
          kind: "person",
          id,
          summary: `Clear leave for personnel ${id}. The person becomes active in personnel-related tests.`,
          request: { method: "POST", path: `/v1/people/${encodeURIComponent(id)}/clear-leave` },
        };
      });
    });

  personnel
    .command("offboard")
    .description(
      "Record offboarding completion; mark unmonitored accounts deactivated without disconnecting external accounts",
    )
    .argument("<id>")
    .requiredOption("--acknowledger-id <id>", "person recorded as completing offboarding")
    .action(async function (this: Command, id: string, options: { acknowledgerId: string }) {
      await mutate(this, () => {
        id = personnelId(id);
        const acknowledgerId = personnelId(options.acknowledgerId, "--acknowledger-id");
        return {
          kind: "offboard",
          id,
          acknowledgerId,
          summary: `Record offboarding completion for personnel ${id}, acknowledged by ${acknowledgerId}. Unmonitored accounts will be marked deactivated. External accounts are not disconnected. Vanta validates remaining eligibility.`,
          request: {
            method: "POST",
            path: "/v1/people/offboard",
            body: { updates: [{ id, acknowledgerId }] },
          },
        };
      });
    });
}

async function prepareOffboarding(
  client: VantaClient,
  plan: Extract<MutationPlan, { kind: "offboard" }>,
  target: unknown,
) {
  const observations = offboardingObservation(target, plan.id);
  const acknowledger = assertPersonIdentity(
    await readPerson(client, plan.acknowledgerId),
    plan.acknowledgerId,
  );
  return {
    ...observations,
    acknowledger: { id: acknowledger.id, name: acknowledger.name.display },
  };
}

async function mutate(command: Command, createPlan: () => MutationPlan): Promise<void> {
  await run(command, async ({ globals, client }) => {
    const plan = createPlan();
    if (!globals.apply) {
      return {
        dryRun: true,
        mutation: true,
        requiresApply: true,
        confirmationRequired: !globals.yes,
        summary: plan.summary,
        request: plan.request,
        guidance:
          "Pass --apply to execute. Target and eligibility observations run only at apply time.",
      };
    }
    const target = await readPerson(client, plan.id);
    const observations =
      plan.kind === "offboard"
        ? await prepareOffboarding(client, plan, target)
        : { target: assertPersonIdentity(target, plan.id) };
    await confirmWrite(
      `${plan.summary}\nApply-time observations: ${JSON.stringify(observations)}`,
      globals,
    );
    const response = await client.request(plan.request);
    if (plan.kind === "offboard") {
      return {
        accepted: true,
        result: assertSingleTargetBulkResult(response, plan.id),
        observations,
        guidance: "Vanta accepted offboarding completion. No post-write state was read.",
      };
    }
    assertPersonIdentity(response, plan.id);
    return response;
  });
}
