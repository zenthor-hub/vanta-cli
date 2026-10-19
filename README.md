# vanta-cli

Agent-safe CLI for Vanta Manage API workflows.

> **Disclaimer:** This is an unofficial, community-maintained project by [zenthor-hub](https://github.com/zenthor-hub). It is not published, endorsed, or supported by Vanta. "Vanta" is a trademark of Vanta Inc.

## Install

Bun >= 1.4.2 is required. CI pins Bun 1.4.2.

```bash
bun install -g @zenthor-hub/vanta-cli
vanta --help
```

From source:

```bash
bun install

# Put the CLI on PATH (Bun global bin). Symlink the source entrypoint:
ln -sfn "$(pwd)/src/vanta.ts" ~/.bun/bin/vanta
# ensure ~/.bun/bin is on your PATH

vanta --help
vanta doctor --json
```

Optional: if you already have a released `vanta` on PATH and want this checkout alongside it:

```bash
ln -sfn "$(pwd)/src/vanta.ts" ~/.bun/bin/vanta-dev
vanta-dev doctor --json
```

For local unreleased development without a global bin:

```bash
bun run src/vanta.ts doctor --json
# or: bun run vanta doctor --json
```

## Agent Documentation

- [AGENTS.md](AGENTS.md): canonical rules for agents.
- [.agents/skills/vanta/SKILL.md](.agents/skills/vanta/SKILL.md): multi-agent skill (symlink into user skill dirs).
- [docs/implementation.md](docs/implementation.md): implementation notes and behavior contracts.
- [.agents/skills/vanta/references/test-descriptions.md](.agents/skills/vanta/references/test-descriptions.md): source-of-truth rules for complete Vanta test descriptions.
- [docs/skills.md](docs/skills.md): skill ownership, packaging, and validation.

This CLI is **curated**, not a full Manage API client. Use `raw` for unsupported endpoints. `bun run schema:check` validates all curated method/path pairs, generated query fields, and typed request-body fields against Vanta's published Manage and Auditor OpenAPI documents.

## Authentication

Create an ignored local config at `~/.vanta-cli.json`:

```json
{
  "clientId": "vci_...",
  "clientSecret": "vcs_...",
  "scope": "vanta-api.all:read vanta-api.all:write"
}
```

Or named profiles for multiple tenants (secret from env or stdin, not CLI flags):

```bash
VANTA_CLIENT_ID=vci_... VANTA_CLIENT_SECRET="$secret" \
  vanta auth profile add --name client-a
# printf '%s' "$secret" | vanta auth profile add --name client-a --client-id vci_...
vanta --profile client-a doctor --json
```

Default config prefers `~/.config/vanta-cli/config.json` (legacy `~/.vanta-cli.json` still works).

Unset previously exported Manage and Auditor credentials before using a profile. Profile selection rejects credential environment variables, `VANTA_CONFIG_PATH`, and `--config`; a missing profile is an error. Token caches are bound to the client ID, base URL, scope, and expiry. Old caches without a client ID refresh automatically. Secrets on stdin may end with EOF or a newline.

Then verify:

```bash
vanta doctor --json
vanta auth status
vanta auth token --force-refresh
```

Auth commands redact access tokens by default. Use `auth token --reveal-token` only when you explicitly need the full bearer token.

## Auditor API Code Changes

The read-only Auditor API command lists code changes associated with a Vanta audit. It requires a
separate Auditor API application and least-privilege `auditor-api.audit:read` credentials:

```bash
export VANTA_AUDITOR_CLIENT_ID="..."
export VANTA_AUDITOR_CLIENT_SECRET="..."

vanta audits code-changes list audit_123 \
  --source github \
  --closed-after 2026-01-01T00:00:00Z \
  --repository acme/api \
  --json
```

Vanta supports search, source, closed-date, and pagination filters. `--repository` is an exact
local filter that automatically scans all returned pages, bounded to 50 pages by default. Use
`--max-pages 1..100` to set a different bound. The public API has no code-change status or justification
field, and it cannot create a “Provide Justification” exception; add that justification in Vanta.

## Mutation Safety

Mutating commands are dry-run by default. They print the request that would be sent and do not call the Vanta API.

```bash
vanta controls deactivate ctrl_123 --json
```

Dry-run output includes stable metadata such as `dryRun`, `mutation`, `requiresApply`, and `confirmationRequired` so agents can inspect planned writes before execution.

Pass `--apply` to execute. Confirmation is still required unless `--yes` is also passed.

```bash
vanta --apply controls deactivate ctrl_123
vanta --apply --yes controls deactivate ctrl_123
```

For larger JSON mutation bodies, prefer `--body-file` over inline shell JSON:

```bash
vanta vendors create --body-file ./tmp/vendor.json --json
```

The documented `tmp/` and `output/` paths are ignored by Git. Keep compliance evidence and request
bodies there instead of placing them in tracked source directories.

## Output Contract

- `--json` writes one complete JSON document to stdout on success, including through Unix pipes. Empty API success bodies become `null`.
- Help and `--version` remain text. Binary downloads under `--json` require `--output`.
- Errors under `--json` are written as `{ "ok": false, "error": ... }` JSON on stderr and omit API
  response bodies so credentials or sensitive provider details are not echoed.
- `--debug --json` includes a stack in the JSON error; human debug errors print a stack separately. Interactive confirmation prompts still go to stderr.
- Human output is for inspection only and should not be parsed.
- Exit code `0` means success, `1` means failure, and `2` means an intentional confirmation abort.

## Safe Downloads

Document downloads refuse to replace an existing output file:

```bash
vanta documents download doc_123 upload_456 --output ./output/evidence.pdf --json
```

Pass `--force` only when replacing that exact file is intended.

## Vanta Tests Dashboard Mapping

The Vanta UI **Tests** dashboard is not just `/v1/tests`.

It combines:

- `/v1/tests` for automated test rows
- `/v1/documents` for document/evidence rows

`--framework` means: include these Vanta frameworks, **plus** automated tests that Vanta does not attach to any of them. Those unmapped rows stay in the result so the CLI matches the Tests dashboard. They are **not** members of the selected frameworks.

Unmapped automated rows use empty `frameworks` and `frameworkMatch: "none"`. `unfiltered` is a CLI collection fallback, not a Vanta framework ID. Do not treat an unmapped overdue test (for example `infra-access-keys-rotated`) as a SOC 2 item just because `--framework soc2` was passed. `tests get` often has no framework list for these rows (category and integrations only), so the CLI cannot honestly recover a framework.

The JSON `summary.unmapped` count is how many rows have `frameworkMatch: "none"`.

Use the dashboard command when you need output that matches the Vanta Tests dashboard:

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

By default (when `--status` is omitted), the command includes `overdue`, `due-soon`, and `needs-remediation`. Automated test remediation statuses map as:

| Vanta API (`remediationStatusInfo.status`) | CLI status                                   |
| ------------------------------------------ | -------------------------------------------- |
| `OVERDUE`                                  | `overdue`                                    |
| `DUE_SOON`                                 | `due-soon`                                   |
| `NEEDS_WORK`                               | `needs-remediation`                          |
| rollout (`isInRollout`)                    | `upcoming` (opt-in via `--include-upcoming`) |

`due-soon` is separate from `upcoming`: Due soon is a remediation urgency bucket; upcoming is rollout-only.

Upcoming rollout rows are excluded unless requested:

```bash
vanta dashboard failing-tests \
  --framework gdpr \
  --framework iso27001_2022 \
  --framework soc2 \
  --include-upcoming \
  --json
```

Filter by Vanta owner:

```bash
vanta dashboard failing-tests \
  --framework soc2 \
  --owner sam@example.com \
  --json
```

Prepare Linear tickets without creating them:

```bash
vanta dashboard failing-tests \
  --framework gdpr \
  --framework iso27001_2022 \
  --framework soc2 \
  --format linear \
  --json
```

The Linear format includes deterministic `ticketKey` values such as:

```text
vanta:documents:external-alerts-reviewed
vanta:tests:approved-gdpr-compliance-policy-exists
```

Use those keys to deduplicate Linear issue creation.

## Test Descriptions

When a user asks for the Vanta test description, do **not** assume the public Manage API `description` field is complete.

Automated test tickets should use the Vanta UI test description, which can include inputs, pass/fail criteria, key terms, current failing results, remediation, mapped controls, and version notes. Document/evidence tickets should use the Vanta document evidence description.

See [.agents/skills/vanta/references/test-descriptions.md](.agents/skills/vanta/references/test-descriptions.md) for the required agent workflow and source-of-truth rules.

## Pagination and request timeouts

Collection commands return one page by default. Use `--all` for a bounded scan:

```bash
vanta tests list --all --max-pages 20 --query statusFilter=NEEDS_ATTENTION --json
vanta tests entities list TEST_ID --all --max-pages 20 --json
vanta audits code-changes list AUDIT_ID --all --max-pages 20 --json
```

The same flags work on other resource lists, document links, and integration resources. `--all` preserves query filters and an optional starting cursor. Results contain `results.data`, terminal `pageInfo`, and `scan.pagesFetched` / `scan.complete`. Missing or repeated cursors and exhausted page bounds fail without emitting partial data. The default bound is 100 pages, or 50 for Auditor scans. Dashboard collection uses the same guard with a 100-page bound per query.

Each HTTP request, including token exchange and file transfers, has a 30-second timeout. Override with `--timeout-ms 60000` (1–600000). Retries remain limited to safe reads; the timeout applies per attempt.

## Verification

```bash
bun run verify
bun run schema:refresh   # bypass the 24-hour OpenAPI cache
```

Verification covers lint, types (including scripts), formatting, unit/process tests, skill references, 47 curated API operations, and installation from a packed tarball outside the checkout. The package includes the Vanta skill and both reference guides. Its smoke check uses synthetic/offline inputs and does not touch global CLI installations.

Schema checks fetch public documents when the cache is absent or older than 24 hours. For offline schema validation, set both `SCHEMA_PATH` and `AUDITOR_SCHEMA_PATH` to downloaded documents. Package installation needs dependencies available in Bun's cache or registry access.

Live Vanta reads are opt-in and accept healthy tenants with no failing rows:

```bash
bun run test:live
```

This requires configured credentials and sets `VANTA_LIVE_TESTS=1`. Ordinary verification does not call Vanta tenant APIs unless that flag is explicitly set.

### Evidence and control relationships

```bash
vanta documents uploads doc_123 --all --json
vanta documents upload doc_123 --file ./evidence.pdf --description "Access review" --effective-at-date 2026-09-18 --json
vanta documents submit doc_123 --json
vanta documents add-link doc_123 --body-file ./tmp/link.json --json
vanta documents remove-link doc_123 link_456 --json
vanta frameworks controls soc2 --all --json
vanta controls tests control_123 --all --json
vanta controls documents control_123 --all --json
vanta documents controls doc_123 --all --json
vanta issues list --query statusMatchesAny=IN_PROGRESS --all --json
vanta policies list --all --json
vanta integrations resource-kinds aws --json
vanta integrations resource-kind aws EC2Instance --json
vanta integrations update-resources aws EC2Instance \
  --region ap-south-1 \
  --in-scope true \
  --set-in-scope false \
  --json
bun run schema:coverage --refresh
```

Mutations above are dry-runs. After reviewing the target and planned request, use
`--apply` to execute. Uploading evidence does not submit it; submission is separate.
Issues and policies also support `get <id>`. Coverage output distinguishes curated
commands, Manage JSON operations reachable through `raw`, and API/transport gaps.

## Releasing

Bump `package.json` and `CHANGELOG.md` in a pull request. Merge it, then push the tag `vX.Y.Z`.

`.github/workflows/publish.yml` runs on `v*` tags and publishes to npm with provenance via npm trusted publishing.
