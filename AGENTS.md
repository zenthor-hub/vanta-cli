# vanta-cli Agent Guide

Prefer the **globally installed** `vanta` binary on PATH. For the local checkout, `vanta-dev` is an optional alias to the same entrypoint (`bun link` or symlink under `~/.bun/bin`) when a released `vanta` is already installed. Inside this repository on unreleased code you may also use `bun run src/vanta.ts …` or `bun run vanta …`.

## Default Commands

```bash
vanta --help
vanta doctor --json
vanta frameworks list --query pageSize=10 --json
```

When auth or config state is uncertain, start with:

```bash
vanta doctor --json
```

Auth output is redacted by default. Do not use `auth token --reveal-token` unless the user explicitly needs a bearer token.

Multi-tenant profiles:

```bash
vanta --profile client-a doctor --json
VANTA_PROFILE=client-a vanta frameworks list --json
```

Use `dashboard failing-tests` when the user asks for failing tests as shown in the Vanta Tests dashboard. The dashboard view is broader than `/v1/tests` and includes document evidence rows from `/v1/documents`.
`--framework` includes those frameworks plus automated tests Vanta does not attach to any of them. Unmapped rows have empty `frameworks` and `frameworkMatch: "none"`; that is not a Vanta framework ID. Do not treat them as belonging to a selected `--framework` (for example `soc2`). See `summary.unmapped`.

```bash
vanta dashboard failing-tests \
  --framework gdpr \
  --framework iso27001_2022 \
  --framework soc2 \
  --status overdue \
  --status due-soon \
  --status needs-remediation \
  --json
```

Prepare Linear ticket data without creating tickets:

```bash
vanta dashboard failing-tests \
  --framework gdpr \
  --framework iso27001_2022 \
  --framework soc2 \
  --format linear \
  --json
```

## Safety Rules

- Read before writing. Use list/get/dashboard/raw reads to confirm the target resource first.
- Mutating commands are dry-run by default. Do not pass `--apply` unless the user explicitly approves the mutation.
- When a mutation is approved, run the dry-run first, inspect the planned request, then rerun with `--apply`. Use `--yes` only when the user has approved skipping prompts.
- For larger mutation bodies, use `--body-file` instead of inline shell JSON. Keep request bodies and downloaded evidence in ignored `tmp/` or `output/` paths.
- For document downloads, use a new `--output` path or pass `--force` only when replacing that exact local file is intended.
- Keep currently failing Vanta tickets open. Verify the source in Vanta before closing; absence from one API query is not completion evidence.
- Keep credentials in `~/.vanta-cli.json`, named profiles under `~/.config/vanta-cli/profiles/`, or environment variables. Never commit secrets.
- Use `raw` as an escape hatch only when no convenience command fits. Pass the exact API path (for example `/v1/frameworks`).
- Integration resource scope, owner, and description use `integrations update-resources`. It is dry-run by default, re-lists filter matches at apply time, and batches patches. Do not use `raw` for that update.
- For parsed output, always pass `--json`.

## Coverage note

This CLI is intentionally **not** a full Vanta Manage API client. Curated commands cover common GRC/agent workflows; everything else uses `raw`. See `docs/implementation.md`.

## Test Descriptions

When the user asks for a Vanta test description, do not rely only on `/v1/tests/{testId}.description`.

Automated test descriptions must use the Vanta UI-backed detail text when the full dashboard description is required. Document/evidence rows should use the Vanta document evidence description from `/v1/documents/{documentId}`.

Follow [docs/vanta-test-descriptions.md](docs/vanta-test-descriptions.md) before preparing or updating Linear ticket descriptions.

## Verification

```bash
bun run verify
```

Live smoke tests require explicit `VANTA_LIVE_TESTS=1` and configured credentials (`bun run test:live`). Standard verification uses offline fixtures and public schema documents.

## Cursor Cloud specific instructions

- Runtime is **Bun** (installed at `~/.bun/bin`, on `PATH` via `~/.bashrc`). Node is present but unused. The startup update script runs `bun install`; you do not need to reinstall dependencies.
- This is a stateless local CLI with **no server, database, or background service** to start. "Running" it means invoking commands (`vanta …` or `bun run src/vanta.ts …`).
- The global `vanta` binary is a symlink to `src/vanta.ts` (`ln -sfn "$(pwd)/src/vanta.ts" ~/.bun/bin/vanta`). Recreate it if missing; otherwise use `bun run src/vanta.ts …`.
- Live API commands need Vanta credentials (`VANTA_CLIENT_ID`/`VANTA_CLIENT_SECRET` or `~/.config/vanta-cli/config.json`), which are absent by default. Credential-free work that still exercises core logic: `vanta doctor --json`, `vanta --help`, and mutation **dry-runs** (e.g. `vanta --json controls deactivate <id>`), which print the planned request without calling the API.
- `bun run verify` and `bun run schema:check` are credential-free; `schema:check` fetches both Vanta OpenAPI documents over the network when its 24-hour cache expires; use `SCHEMA_PATH` and `AUDITOR_SCHEMA_PATH` for offline checks. `schema:refresh` forces a refresh. The gate also checks skill links and installs a tarball in a temporary directory without changing the global CLI.
