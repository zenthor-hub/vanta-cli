---
name: vanta
description: Safely inspect Vanta compliance data, gather dashboard-matching failing tests, prepare Linear remediation tickets, and perform approved Manage API mutations with the globally installed vanta CLI. Use for Vanta tests, documents, controls, vendors, vulnerabilities, personnel, audits, and raw API access.
---

# Vanta CLI

Use the **`vanta`** binary on PATH. Check `vanta --version` and `vanta --help` to identify the installed version and commands. For source installation, run `bun install` and `bun link` from the checkout; the installed CLI works from any directory. The companion skill and its references are included in the package.

## Default commands

```bash
vanta doctor --json
vanta auth status --json
vanta frameworks list --query pageSize=10 --json
vanta dashboard failing-tests \
  --framework gdpr \
  --framework iso27001_2022 \
  --framework soc2 \
  --status overdue \
  --status due-soon \
  --status needs-remediation \
  --json
vanta dashboard failing-tests \
  --framework soc2 \
  --format linear \
  --json
vanta vulnerabilities list --query pageSize=20 --json
vanta vulnerabilities get VULN_ID --json
```

## Profiles (multi-tenant)

```bash
VANTA_CLIENT_ID=vci_... VANTA_CLIENT_SECRET="$secret" \
  vanta auth profile add --name client-a
# Or: printf '%s' "$secret" | vanta auth profile add --name client-a --client-id vci_...
vanta --profile client-a doctor --json
VANTA_PROFILE=client-a vanta frameworks list --json
vanta auth profile list
vanta auth profile remove --name client-a
```

Secrets for profile add come from `VANTA_CLIENT_SECRET` or stdin (not `--client-secret` argv). A selected profile cannot be combined with Manage or Auditor credential environment variables, `VANTA_CONFIG_PATH`, or `--config`. Unset previously exported credentials before selecting a profile. Missing profiles are errors; cached tokens must match the configured client ID.

## Safety rules

- Prefer `vanta … --json` for any output that will be parsed or copied into another workflow.
- Start with `vanta doctor --json` when auth, token cache, or API reachability is uncertain.
- Use `dashboard failing-tests` for the Vanta Tests dashboard. Do not assume `/v1/tests` alone matches the dashboard. `--framework` also includes unmapped automated tests (`frameworkMatch: "none"`); that is not a Vanta framework ID.
- For downloads, use a new output path or pass `--force` only when replacing that exact local file is intended. Raw GET supports `--output`; saved output preserves exact bytes and returns metadata under `--json`.
- Keep currently failing Vanta tickets open. Verify the source in Vanta before closing; absence from one API query is not completion evidence.
- Read resources before writing. Mutating commands are dry-run by default; `--apply` only after explicit user approval.
- Prefer `--body-file` for larger JSON mutation bodies.
- Raw multipart uses `--form key=value` and `--file field=path` for POST, PUT, or PATCH. JSON bodies cannot combine with multipart. Dry-runs send no API or token requests.
- Use `raw` only as an escape hatch. Pass the exact Manage API path, including `/v1` when required by the endpoint style used in this CLI (`/v1/...`).
- Update integration resource scope, owner, or description with `integrations update-resources`, not `raw`. Dry-run lists the matches; `--apply` lists again before patching.
- Keep credentials and access tokens out of arguments, committed files, Linear tickets, and chat output. Auth output is redacted by default.
- When the user asks for a Vanta test description, follow [references/test-descriptions.md](references/test-descriptions.md); the public tests API description can be incomplete.

Personnel mutations use `personnel update`, `set-leave`, `clear-leave`, and `offboard`. Names require a pair. Leave requires an end date or explicit `--indefinite`. Offboarding requires `--acknowledger-id` and Vanta validates remaining eligibility after apply-time observations. These commands dry-run without API reads. See [references/command-guide.md](references/command-guide.md).

Use `--all --max-pages 20` for bounded multi-page list reads. A failed scan returns an error rather than incomplete results. HTTP requests time out after 30 seconds; use `--timeout-ms` to override. Under `--json`, downloads require `--output`.

## Workflow

1. Verify auth with `vanta doctor --json` or `vanta auth status --json` when needed.
2. For dashboard-matching failing tests, use `dashboard failing-tests` with explicit framework and status filters.
3. For Linear preparation, use `--format linear --json` and preserve the deterministic `ticketKey` for deduplication.
4. For document/evidence rows, fetch document details and use the evidence description.
5. For mutations, dry-run first, inspect the request, and only rerun with `--apply` after clear user approval.

## Local CLI development only

```bash
bun run src/vanta.ts …
# or
bun run vanta -- …
```

## Command reference

Read [references/command-guide.md](references/command-guide.md) for exact examples, dashboard filters, raw API usage, mutation safety, exit codes, and description source rules.
