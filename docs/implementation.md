# vanta-cli Implementation Notes

`vanta-cli` is a local, agent-safe command-line interface for Vanta Manage API workflows. It is designed for Codex and other agents that need predictable JSON output, dry-run mutation safety, and dashboard-aware compliance data.

## API and Authentication Model

The CLI authenticates with Vanta OAuth client credentials from local config or environment variables. Configuration prefers `~/.config/vanta-cli/config.json` and falls back to `~/.vanta-cli.json`; credentials must stay untracked.

Authentication output is secret-safe by default. `auth status` returns credential/cache metadata without cached token material, and `auth token` returns a redacted token preview unless `--reveal-token` is explicitly passed. The `doctor` command provides read-only diagnostics for config, cache mode, cache usability, and a harmless framework read when credentials are configured.

Convenience commands target Manage or separately scoped Auditor API `/v1` endpoints. The `raw` command is the exception: it sends the exact path provided by the caller, so agents must include `/v1` manually.

Resource commands cover the common read surfaces:

- `frameworks`
- `tests`
- `personnel`
- `controls`
- `documents`
- `vendors`
- `integrations`
- `vulnerabilities`
- `issues`
- `policies`

`tests entities list <testId>` reads individual failing or deactivated test entities. Test-entity deactivation and reactivation are typed convenience mutations; they are intentionally not implemented as generic JSON-body commands.

Named credential profiles live under `~/.config/vanta-cli/profiles/` and are selected with `--profile` or `VANTA_PROFILE`. Idempotent Manage API reads retry on HTTP 429/5xx with capped exponential backoff. All multi-page fetches reject missing/repeated cursors and stop at an explicit page bound. Curated collection commands offer `--all --max-pages`; single-page reads remain the default. Each HTTP attempt has a 30-second timeout, configurable with `--timeout-ms`.

Token caches include the client ID and are reused only when identity, URL, scope, and expiry match. Legacy unbound caches refresh. Missing profiles fail before reading a token cache; Manage and Auditor credential environment variables cannot override a selected profile.

Unsupported endpoints should be reached through `raw` only after checking whether a convenience command already exists. Full Manage OpenAPI parity is intentionally out of scope; `bun run schema:check` validates all curated method/path pairs and their generated query/typed body fields against the published Manage and Auditor OpenAPI documents. `schema:refresh` bypasses the 24-hour cache.

## Dashboard Data Model

The Vanta Tests dashboard is not represented by `/v1/tests` alone. The dashboard-matching failing tests command combines:

- `/v1/tests` for automated test rows.
- `/v1/documents` for document/evidence rows.

Automated tests are collected from both the selected `frameworkFilter` queries and an unfiltered `statusFilter=NEEDS_ATTENTION` fallback. The fallback is required because some Vanta tests can be visible in the dashboard but absent from the selected framework-filtered Manage API result sets.

`dashboard failing-tests` normalizes those rows into a single remediation-oriented result with counts, status, owner, category, frameworks, source, source ID, and Vanta URL. The `--format linear` mode converts the same rows into ticket preparation payloads with stable `ticketKey` values for deduplication.

Automated remediation statuses map as:

| Vanta API (`remediationStatusInfo.status`) | CLI status          | Default filter            | Linear priority |
| ------------------------------------------ | ------------------- | ------------------------- | --------------- |
| `OVERDUE`                                  | `overdue`           | yes                       | High            |
| `DUE_SOON`                                 | `due-soon`          | yes                       | Medium          |
| `NEEDS_WORK`                               | `needs-remediation` | yes                       | Medium          |
| rollout (`isInRollout`)                    | `upcoming`          | no (`--include-upcoming`) | Low             |

Sort order is `overdue`, `due-soon`, `needs-remediation`, then `upcoming`. Document rows still use upload/renewal heuristics and do not emit `due-soon`.

Upcoming rollout rows are excluded unless `--include-upcoming` is passed.

### Known Framework Filter Gap

`infra-access-keys-rotated` is the concrete regression case:

- Name: `Enabled IAM User Access Keys must not be older than 90 days`
- API behavior: when failing, it can appear in unfiltered `/v1/tests?statusFilter=NEEDS_ATTENTION` but be missing from `/v1/tests` when filtered by `gdpr`, `iso27001_2022`, or `soc2`.
- Dashboard impact: a CLI that only trusts framework-filtered automated test queries omits rows like this from ticket prep even though Vanta shows them.
- CLI behavior: unfiltered automated rows that were not already found through framework filters are still included. They use empty `frameworks` and `frameworkMatch: "none"` (counted in `summary.unmapped`). That marker is a CLI invention, not a Vanta framework ID.

## Mutation Safety Model

Mutating commands are dry-run by default. A dry-run prints the planned request and does not call the mutating endpoint.

To execute a mutation, the caller must pass `--apply`. Confirmation is still required unless `--yes` is also passed. Agents should only use `--apply` after explicit user approval and should dry-run first.

Dry-run payloads include stable machine-readable metadata: `dryRun`, `mutation`, `requiresApply`, `confirmationRequired`, `summary`, `request`, and `guidance`. Confirmation prompts are written to stderr so stdout remains parseable for `--json` callers.

Convenience mutation commands that accept JSON bodies also accept `--body-file`. Passing both `--body` and `--body-file` is rejected.

Intentional confirmation aborts preserve the `CliError.exitCode`; declining a prompt exits with code `2`. Normal failures exit with code `1`.

### Test Entity Mutations

Use `tests entities list <testId>` to inspect an entity before changing it. Deactivation requires `--reason` and supports an optional RFC 3339 `--until`; omitting it deactivates the entity indefinitely. Both deactivation and reactivation do an apply-time read of the target in its expected state before prompting: `FAILING` for deactivation and `DEACTIVATED` for reactivation.

Vanta accepts both operations asynchronously. Successful calls return a structured `{ accepted: true, pending: true }` result rather than claiming the state has already changed; Vanta can delay the visible change until the next test run. Do not use these commands for vulnerabilities, which have separate Vanta endpoints.

### Vulnerability mutations

`vulnerabilities deactivate`, `reactivate`, and `remediations acknowledge-sla-miss` send one update in the API's `updates` array. Apply-time reads verify the target before confirmation. Dry-runs perform neither target reads nor token requests.

Each mutation requires exactly one result with the requested ID. Malformed results and per-entry `ERROR` responses exit nonzero, including errors inside HTTP 200 responses. Arbitrary server messages are redacted. Integration-resource batch behavior is unchanged.

Deactivation requires an explicit reactivation policy and accepts a future expiry. Reactivation skips an explicitly active target. Deactivation never skips an update because the read response cannot prove the requested reactivation policy already matches. Successful responses describe acceptance without claiming an immediate state change.

Assets and remediations have bounded collection reads. SLA acknowledgement performs a filter-narrowed bounded lookup that stops at the matching ID. A scan-limit failure differs from a complete filtered scan without a match. The documented remediation fields establish existence, not SLA eligibility. See the [vulnerability command reference](vulnerabilities.md).

## Output and Error Conventions

Use `--json` for machine-readable output. Successful JSON is written as one complete stdout document, including through Unix pipes. JSON errors use a redacted machine-readable envelope on stderr. Human output is intended for direct inspection and should not be parsed by another tool.

Argument parsing and command failures share the CLI error handler. Empty successful bodies serialize as JSON `null`. Downloads require `--output` in JSON mode. `--debug --json` embeds the stack in the error object instead of appending non-JSON text. Help/version remain text, and interactive confirmation prompts use stderr.

## Test Description Contract

When the user asks for a Vanta test description, the correct source depends on the row type:

- Automated test rows require the Vanta UI-backed detail description when a complete dashboard description is expected.
- Document/evidence rows use document details from `/v1/documents/{documentId}`.

The public Manage API test `description` field can omit remediation-critical context. Follow [vanta-test-descriptions.md](vanta-test-descriptions.md) for the required source-of-truth rules before preparing or updating Linear tickets.

## Verification Strategy

The standard gate is:

```bash
bun run verify
```

That command runs lint, typecheck (including scripts), formatting, unit/process tests, skill/link checks, OpenAPI contract checks, and a package installation smoke test outside the checkout. It must remain credential-free. Process-level smoke tests that use real Vanta credentials run only with `VANTA_LIVE_TESTS=1` and configured credentials. Zero failing rows is a valid result.

GitHub Actions runs the same credential-free gate for pushes to `main` and pull requests.

## Evidence and relationship commands

`documents uploads <documentId>` lists uploaded files. `documents upload` accepts
`--description` and `--effective-at-date`. Upload and submission are separate actions:
use `documents submit <documentId>` to submit evidence, with the usual dry-run and
`--apply` confirmation. `documents add-link <documentId> --body-file <path>` accepts
the API's JSON link body; `documents remove-link <documentId> <linkId>` removes one.
The existing `documents links <documentId>` read command is unchanged.

Read relationships with `frameworks controls`, `controls tests`, `controls documents`,
and `documents controls`, each followed by the parent ID. These and `documents uploads`
support `--query`, `--all`, and `--max-pages`. `issues` and `policies` offer `list` and
`get`; list filters use repeatable `--query key=value`.
`integrations resource-kinds <integrationId>` returns the API's unpaginated array.
`integrations resource-kind <integrationId> <resourceKind>` returns counts (`numResources`, `numInScope`, `numOwned`, `numWithDescription`) and capability flags (`isScopable`, `canUpdateOwner`, `canUpdateDescription`). Pass `--connection-id` to scope those counts to one connection.

`integrations update-resources <integrationId> <resourceKind>` sets `inScope`, `ownerId`, and/or `description`. Select explicit `--id` values and/or filters (`--region`, `--account`, `--connection-id`, `--display-name` as a regular expression, `--in-scope`). A selector is required. The command reads the resource kind first and refuses the update when Vanta reports the requested field is unsupported. Filter selection re-lists every matching page at dry-run and again at apply time, skips resources that already have the requested values, and sends `PATCH` bodies of at most 50 `updates`. Dry-run performs those reads and does not call the mutating endpoint. `--apply` asks for confirmation unless `--yes` is set; the prompt lists every freshly matched target by display name and id. Per-entry `ERROR` results are returned in the summary and the process exits non-zero.

`bun run schema:coverage` emits JSON covering every published operation, grouped as
`curated`, `raw`, `unsupported-api` (Auditor mutations or unavailable transports), or
`unsupported-transport` (request or response transports the CLI cannot represent).
Manage raw supports JSON, multipart POST/PUT/PATCH, and exact-byte GET output.
Multipart and file operations include transport metadata in the coverage report. This is an
endpoint/transport inventory, not a guarantee of account permissions or complete
optional-field coverage. Add `--refresh` to fetch current specs. Offline overrides
are the same as `schema:check`.

## Raw multipart and output contract

`raw` retains single-request JSON behavior by default. Multipart fields are typed
text or file parts. `--form` preserves text literally, including JSON strings and
`=`. `--file` supplies a regular file, and `--file-type` optionally overrides its
MIME type. Known extensions include PDF, JSON, text, CSV, common images, and ZIP;
unknown extensions use `application/octet-stream`.

| Options                 | Compatible methods and options                                   |
| ----------------------- | ---------------------------------------------------------------- |
| `--body`, `--body-file` | Mutually exclusive; cannot combine with multipart or output      |
| `--form`, `--file`      | POST, PUT, PATCH; repeatable with unique field names             |
| `--file-type`           | Requires a matching `--file`; one MIME override per field        |
| `--output`              | GET only; preserves exact bytes and returns file metadata        |
| `--force`               | Requires `--output`; atomically replaces an existing destination |

Multipart mutations never retry automatically. Dry-runs validate file metadata
but send no API or token requests. File transfer buffers the response in memory;
there is no streaming, resume, or size guarantee. A completed temporary file in
the destination directory is published by hard link for atomic no-clobber output,
or rename for atomic force replacement. Document downloads use the same helper.
Handled failures remove temporary output; an uncatchable process kill may leave it.

`test/raw-transfer.test.ts` drives the CLI against local fixtures for the eleven
Manage operations requiring multipart or binary output. The schema gate separately
checks those fixture field contracts without counting them as curated commands.
Raw does not validate arbitrary requests against OpenAPI at runtime.

## Raw pagination

`raw GET` accepts `--all --max-pages 1..100` for the standard Vanta collection
format. The default bound is 100 pages. The shared scanner validates each page's
array data and pagination metadata before consuming it. Errors identify the
endpoint and page number, and no aggregate success document is emitted when any
page fails.

Scans return aggregated data, a final `hasNextPage: false`, and
`scan: { pagesFetched, complete: true, startedAtCursor }`. The cursor is `null`
when the scan began at the beginning. Completion applies only to the walk from
that cursor. Extra endpoint metadata such as `totalCount` is not preserved by
aggregation; single-page responses remain unchanged. Filters and server order
are preserved. A scan is not a snapshot across concurrent server updates.

## Auditor reads

The `audits` root provides audit list/get, controls list, evidence list/get/urls,
information-requests list/get, and the existing code-changes list command.
All commands use `runAuditor` and `loadAuditorConfig`, including per-profile Auditor
credentials, base URL, scope, and a separate identity-bound token cache.
Missing Auditor credentials never fall back to Manage credentials.

`raw --api auditor` accepts GET only with an exact `/v1/` path. It rejects methods,
bodies, multipart fields, and file output before loading config or credentials,
even with `--apply --yes`. `--api manage` remains the default and retains file
transfer and mutation behavior. Both APIs reuse the validated bounded scanner.
Collection reads preserve deleted records, marked by a non-null `deletionDate`.
Single-page responses retain API metadata. Aggregation drops endpoint metadata
such as evidence `totalCount` and reports the scan's starting cursor.

Evidence URL retrieval is paginated and requires exactly one audit program
segment. Vanta returns HTTP 422 for unsupported segment counts. URLs are
short-lived bearer capabilities. The CLI returns them in the requested output
without fetching them or writing extra logs. Auditor API errors retain HTTP
status but omit response bodies, which can contain evidence URLs. Credential
and scope guidance names the Auditor settings. Manage error output is unchanged.

The cached Auditor inventory contains 38 GET operations. Nine have curated
commands, 29 are raw-readable, and 19 mutation operations remain unsupported.
`bun run schema:coverage` regenerates the counts from the selected schemas.
`test/auditor-reads.test.ts` checks real CLI requests against local HTTP fixtures,
including encoded IDs, query filters, scans, profile and cache isolation,
forbidden methods before token requests, error statuses, and signed URL handling.
