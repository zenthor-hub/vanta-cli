import { Command } from "commander";

import { run } from "../cli-run.ts";
import {
  buildFailingTestsDashboard,
  DASHBOARD_STATUS_HELP,
  DEFAULT_FAILING_TEST_STATUSES,
  isDashboardStatus,
  toLinearTicketPrep,
  type DashboardStatus,
} from "../dashboard.ts";
import { CliError } from "../errors.ts";
import { collect } from "../io.ts";

export function registerDashboardCommands(program: Command): void {
  const dashboard = program.command("dashboard").description("Dashboard-matching read models");
  dashboard
    .command("failing-tests")
    .description(
      "List failing Tests dashboard rows across automated tests and documents. --framework includes those frameworks plus automated tests Vanta does not attach to any of them (frameworkMatch: none).",
    )
    .option(
      "--framework <framework>",
      "Vanta framework ID, repeatable. Also includes automated tests not attached to any selected framework (empty frameworks, frameworkMatch: none). unfiltered is not a Vanta framework.",
      collect,
      [],
    )
    .option("--status <status>", `${DASHBOARD_STATUS_HELP}; repeatable`, collect, [])
    .option("--owner <owner>", "owner email/name/ID, or unassigned; repeatable", collect, [])
    .option("--include-upcoming", "include upcoming rollout rows")
    .option("--format <format>", "output format: dashboard or linear", "dashboard")
    .action(async function (
      this: Command,
      options: {
        framework: string[];
        status: string[];
        owner: string[];
        includeUpcoming?: boolean;
        format: string;
      },
    ) {
      await run(this, ({ client }) => {
        const frameworks = options.framework;
        if (frameworks.length === 0) throw new CliError("At least one --framework is required.");
        const statuses = parseDashboardStatuses(
          options.status.length > 0 ? options.status : DEFAULT_FAILING_TEST_STATUSES,
        );
        const format = parseDashboardFormat(options.format);
        return buildFailingTestsDashboard(client, {
          frameworks,
          statuses,
          owners: options.owner,
          includeUpcoming: options.includeUpcoming,
        }).then((dashboard) => (format === "linear" ? toLinearTicketPrep(dashboard) : dashboard));
      });
    });
}

export function parseDashboardStatuses(statuses: string[]): DashboardStatus[] {
  const normalized = statuses.map((status) => status.toLowerCase());
  const invalid = normalized.filter((status) => !isDashboardStatus(status));
  if (invalid.length > 0) {
    throw new CliError(`Invalid dashboard status: ${invalid.join(", ")}`);
  }
  return [...new Set(normalized.filter(isDashboardStatus))];
}

export function parseDashboardFormat(format: string): "dashboard" | "linear" {
  const normalized = format.toLowerCase();
  if (normalized === "dashboard" || normalized === "linear") return normalized;
  throw new CliError(`Invalid dashboard format: ${format}`);
}
