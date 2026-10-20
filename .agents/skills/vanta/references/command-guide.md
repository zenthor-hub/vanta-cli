# Vanta CLI Command Guide

Use the `vanta` binary on PATH. When developing the CLI from source, `bun run src/vanta.ts …` is equivalent.

## Auth

Check whether local credentials are configured:

```bash
vanta auth status --json
```

Run read-only diagnostics:

```bash
vanta doctor --json
```

Force a token refresh when validating credentials:

```bash
vanta auth token --force-refresh --json
```

Token output is redacted by default. Reveal the full token only when explicitly needed:

```bash
vanta auth token --force-refresh --reveal-token --json
```

Credentials usually live in `~/.vanta-cli.json`:

```json
{
  "clientId": "vci_...",
  "clientSecret": "vcs_...",
  "scope": "vanta-api.all:read vanta-api.all:write"
}
```

Do not commit or print real secrets.

Named profiles (multi-tenant):

```bash
VANTA_CLIENT_ID=vci_... VANTA_CLIENT_SECRET="$secret" \
  vanta auth profile add --name client-a
# Or: printf '%s' "$secret" | vanta auth profile add --name client-a --client-id vci_...
vanta --profile client-a doctor --json
vanta auth profile list
vanta auth profile remove --name client-a
```

Profiles live under `~/.config/vanta-cli/profiles/`. Default config prefers `~/.config/vanta-cli/config.json`, with fallback to legacy `~/.vanta-cli.json`. A selected profile cannot be combined with Manage or Auditor env credentials, `VANTA_CONFIG_PATH`, or `--config`. Unset previously exported credentials before using a profile.

## Vulnerabilities

```bash
vanta vulnerabilities list --query pageSize=20 --json
vanta vulnerabilities get VULN_ID --json
vanta vulnerabilities assets list --all --query assetType=SERVER --json
vanta vulnerabilities assets get ASSET_ID --json
vanta vulnerabilities remediations list --all --query severity=HIGH --json
vanta vulnerabilities deactivate VULN_ID --reason "Accepted risk" --reactivate-when-fixable true --json
vanta vulnerabilities reactivate VULN_ID --json
vanta vulnerabilities remediations acknowledge-sla-miss REMEDIATION_ID --comment "Dependency release delayed" --json
```

Vulnerability mutations are dry-run by default and make no token or API requests until `--apply`. Inspect the target first, then dry-run and obtain approval before applying. Add `--yes` only when skipping confirmation is approved.

Deactivation requires a nonempty reason and explicit `--reactivate-when-fixable true|false`. Optional `--until` accepts a future RFC 3339 date-time. Omitted expiry follows the API contract and does not confirm an indefinite exception. Reactivation returns `noChange` only when the apply-time read explicitly shows active monitoring. Deactivation always sends requested settings because the read metadata omits the reactivation policy.

SLA acknowledgement requires `--comment`. It uses a bounded existence scan at apply time, narrowed with repeatable `--query` filters and `--max-pages` from 1 to 100. Vanta checks SLA eligibility. HTTP 200 per-entry errors still exit nonzero. [Vulnerability command reference](../../../../docs/vulnerabilities.md) describes request and lookup limits.

## Auditor API reads

Audit data is provided by Vanta's separate Auditor API application. Configure it with a
least-privilege `auditor-api.audit:read` scope; it uses a distinct token cache from the Manage API:

```bash
export VANTA_AUDITOR_CLIENT_ID="..."
export VANTA_AUDITOR_CLIENT_SECRET="..."
```

Read audits and their related records:

```bash
vanta audits list --query isActiveAudit=true --all --json
vanta audits get AUDIT_ID --json
vanta audits controls list AUDIT_ID --all --json
vanta audits evidence list AUDIT_ID --query changedSinceDate=2026-01-01T00:00:00Z --all --json
vanta audits evidence get AUDIT_ID EVIDENCE_ID --json
vanta audits evidence urls AUDIT_ID EVIDENCE_ID --json
vanta audits information-requests list AUDIT_ID --all --json
vanta audits information-requests get AUDIT_ID REQUEST_ID --json
vanta raw GET /v1/audits --api auditor --all --json
```

Collection reads preserve query filters, order, and deleted rows with a `deletionDate`.
Use `--all --max-pages 1..100` for bounded scans, with a default of 100 pages.
Signed evidence URLs are short-lived bearer capabilities. Return them only when requested.
The CLI does not download them. URL retrieval requires exactly one audit program segment,
otherwise Vanta returns HTTP 422. Auditor error output omits response bodies.

`raw --api auditor` accepts GET only with no body, multipart, or file output.
It requires separate Auditor credentials and never falls back to Manage credentials.
The default raw API remains Manage. Auditor mutations are unsupported.

List code changes associated with an audit:

```bash
vanta audits code-changes list audit_123 \
  --source github \
  --closed-after 2026-01-01T00:00:00Z \
  --closed-before 2026-12-31T23:59:59Z \
  --page-size 100 \
  --json
```

The Auditor API supports `--search`, repeatable `--source`, `--closed-after`,
`--closed-before`, pagination, and a local exact `--repository` match. When `--repository` is used,
the CLI automatically scans all pages from the optional starting cursor, bounded to 50 pages by
default. Set `--max-pages 1..100` when a different explicit bound is needed. The endpoint does not
expose code-change status or justification fields, and Vanta's public API does not provide a way to
create a code-change justification; add that justification in Vanta.

## Read Commands

List frameworks:

```bash
vanta frameworks list --query pageSize=10 --json
```

List automated tests directly from the Manage API:

```bash
vanta tests list --query pageSize=10 --json
```

Get one test:

```bash
vanta tests get approved-gdpr-compliance-policy-exists --json
```

List the failing entities for one test:

```bash
vanta tests entities list approved-gdpr-compliance-policy-exists \
  --status failing \
  --page-size 100 \
  --json
```

List documents:

```bash
vanta documents list --query pageSize=10 --json
```

Get one document:

```bash
vanta documents get external-alerts-reviewed --json
```

Use these lower-level commands for direct endpoint data. Use `dashboard failing-tests` when the user asks for the Vanta Tests dashboard.

Also available as convenience `list`/`get` resources: `personnel`, `controls`, `vendors`, `integrations`, `vulnerabilities`.

## Dashboard-Matching Failing Tests

The Vanta Tests dashboard includes automated test rows and document/evidence rows. Use this command for dashboard-matching remediation work:

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

Default statuses (when `--status` is omitted) are `overdue`, `due-soon`, and `needs-remediation`. `due-soon` maps from Vanta `remediationStatusInfo.status = DUE_SOON` and is distinct from rollout `upcoming`.

Include upcoming rollout rows only when requested:

```bash
vanta dashboard failing-tests \
  --framework gdpr \
  --framework iso27001_2022 \
  --framework soc2 \
  --include-upcoming \
  --json
```

Filter by owner:

```bash
vanta dashboard failing-tests \
  --framework soc2 \
  --owner sam@example.com \
  --json
```

Prepare Linear ticket payloads without creating tickets:

```bash
vanta dashboard failing-tests \
  --framework gdpr \
  --framework iso27001_2022 \
  --framework soc2 \
  --status overdue \
  --status due-soon \
  --status needs-remediation \
  --format linear \
  --json
```

The Linear output includes stable `ticketKey` values. Use those keys to deduplicate tickets.

`--framework` includes the selected frameworks plus automated tests Vanta does not attach to any of them. Collection uses an unfiltered `NEEDS_ATTENTION` fallback so dashboard-visible tests missing from `frameworkFilter` still appear. The known case is `infra-access-keys-rotated` (`Enabled IAM User Access Keys must not be older than 90 days`): present in unfiltered `/v1/tests` but missing from `gdpr`, `iso27001_2022`, and `soc2` filters. Those rows have empty `frameworks` and `frameworkMatch: "none"`; `unfiltered` is not a Vanta framework.

Do not close a Linear ticket because it disappeared from one query; verify the source directly in Vanta.

## Document Downloads

Downloads refuse to overwrite an existing output path:

```bash
vanta documents download doc_123 upload_456 \
  --output ./output/evidence.pdf \
  --json
```

Pass `--force` only when replacing that exact file is intended.

## Raw Manage API Calls

Use `raw` for unsupported endpoints. The CLI does not add `/v1`; pass the exact path:

```bash
vanta raw GET /v1/frameworks --query pageSize=10 --json
```

With a JSON body:

```bash
vanta raw PATCH /v1/vendors/vendor_123 --body '{"displayName":"Updated vendor"}' --json
```

For larger bodies, use a local ignored file:

```bash
vanta raw PATCH /v1/vendors/vendor_123 --body-file ./tmp/vendor-update.json --json
```

Multipart mutations use repeatable text and file fields. Run the dry-run first:

```bash
vanta raw POST /v1/vendors/vendor_123/documents --file file=./output/evidence.pdf --form type=SOC2_REPORT --json
vanta raw POST /v1/vendors/vendor_123/set-status --form status=MANAGED --json
```

After explicit approval, rerun with `--apply`. Use `--yes` only if prompt bypass
was also approved. Multipart supports POST, PUT, and PATCH. Do not combine JSON
body options with multipart. Field names must be unique; empty text values and
values containing `=` are preserved. `--file-type field=mime` overrides a supplied
file's inferred MIME type. Unknown extensions use `application/octet-stream`.

Save raw GET bytes with `--output`. JSON output then reports the saved path and
byte count. Existing destinations are preserved unless `--force` is selected;
publication is atomic for document and raw downloads. `--force` requires an
output path, and output cannot combine with a request body.

```bash
vanta raw GET /v1/trust-centers/acme/resources/resource_123/media --output ./output/resource.bin --json
```

## Integration resource metadata

List kinds, then read one kind's counts and capability flags:

```bash
vanta integrations resource-kinds aws --json
vanta integrations resource-kind aws EC2Instance --json
```

Take every in-scope EC2 instance in one region out of scope. The dry-run lists matching resources and shows the PATCH bodies. It does not update them. Filter matches are listed again when you apply, so instances that appeared after the dry-run are included.

```bash
vanta integrations update-resources aws EC2Instance \
  --region ap-south-1 \
  --in-scope true \
  --set-in-scope false \
  --json
```

After explicit approval:

```bash
vanta --apply integrations update-resources aws EC2Instance \
  --region ap-south-1 \
  --in-scope true \
  --set-in-scope false \
  --json
```

`--id` may be repeated. `--account` matches `account`, `accountName`, `accountId`, or `awsAccountNumber`. `--display-name` is a JavaScript regular expression. `--owner-id` and `--description` set those fields. The command refuses the run when the kind is not scopable or cannot update owner or description. At least one selector is required. Updates are sent in batches of at most 50. Without `--yes`, the apply prompt lists every freshly matched target before asking to proceed.

## Mutations

Mutating commands are dry-run by default:

```bash
vanta controls deactivate ctrl_123 --json
```

The dry-run prints the method, path, and body that would be sent. It does not call the mutating endpoint. `integrations update-resources` is the exception for reads: its dry-run lists matching resources so the planned ids are exact, and still does not PATCH.
Dry-run JSON includes `dryRun`, `mutation`, `requiresApply`, `confirmationRequired`, `summary`, `request`, and `guidance`.

Use body files for larger JSON mutation requests:

```bash
vanta vendors create --body-file ./tmp/vendor.json --json
```

After explicit user approval, apply the mutation:

```bash
vanta --apply controls deactivate ctrl_123 --json
```

Skip the confirmation prompt only when the user approved that too:

```bash
vanta --apply --yes controls deactivate ctrl_123 --json
```

### Test Entity Deactivation

Read the entity first, then plan the mutation. The CLI repeats this read at apply time and only proceeds when the entity is in the expected state.

```bash
vanta tests entities list aws-account-access-removed-on-termination \
  --status failing \
  --json

vanta tests entities deactivate \
  aws-account-access-removed-on-termination \
  entity_123 \
  --reason "Accepted exception tracked in RISK-123" \
  --until 2026-12-31T23:59:59Z \
  --json
```

Omit `--until` only when an indefinite deactivation is intended. After explicit approval, apply the planned request:

```bash
vanta --apply tests entities deactivate \
  aws-account-access-removed-on-termination \
  entity_123 \
  --reason "Accepted exception tracked in RISK-123" \
  --json
```

Reactivate only an entity shown as deactivated:

```bash
vanta --apply tests entities reactivate \
  aws-account-access-removed-on-termination \
  entity_123 \
  --json
```

Vanta accepts these operations asynchronously; inspect the entity again after the next test run. Vulnerabilities require Vanta's separate vulnerability endpoints.

## Personnel changes

```bash
vanta personnel update PERSON_ID --first-name "Example" --last-name "Person" --json
vanta personnel update PERSON_ID --employment-start-date 2026-01-01T00:00:00Z --json
vanta personnel set-leave PERSON_ID --start-date 2026-11-01T00:00:00Z --indefinite --json
vanta personnel set-leave PERSON_ID --start-date 2026-11-01T00:00:00Z --end-date 2026-12-01T00:00:00Z --json
vanta personnel clear-leave PERSON_ID --json
vanta personnel offboard PERSON_ID --acknowledger-id ACKNOWLEDGER_PERSON_ID --json
```

Names require a first and last name together. All dates require RFC 3339 seconds and a timezone. Leave requires exactly one of an end date or `--indefinite`; only the latter sends null. Clear-leave sends no body and makes the person active in personnel-related tests.

Dry-runs make no token or API requests. After explicit approval, rerun the planned command with `--apply`. Offboarding reads both people, displays apply-time employment and custom offboarding task state, and blocks visible incomplete prerequisites. Vanta checks remaining eligibility because Person does not expose all monitored accounts. Completion marks unmonitored accounts deactivated without disconnecting external accounts. A per-entry error exits nonzero even after HTTP 200. No post-write state is claimed.

## Test Description Sources

When preparing Linear tickets or remediation summaries:

- Automated tests need Vanta UI-backed detail text when the user asks for the proper dashboard description.
- `/v1/tests/{testId}.description` can be too thin for remediation.
- Use `descriptionEnhanced`, failing result descriptors, failure text, remediation text, mapped controls, and version notes when available from the Vanta UI.
- Document/evidence rows should use `/v1/documents/{documentId}` and the document evidence description.
- Follow [test-descriptions.md](test-descriptions.md) before creating or updating ticket descriptions.

## Exit Codes

- `0`: command succeeded.
- `1`: normal failure, such as missing credentials or API errors.
- `2`: intentional CLI abort, such as declining a confirmation prompt.

With `--json`, successes are one complete JSON document on stdout. Failures are redacted JSON on
stderr with `ok: false`; API response bodies are omitted.

## Verification

Run the standard repository gate after changes:

```bash
bun run verify
```

Verification requires no Vanta credentials. Live reads run only with `VANTA_LIVE_TESTS=1` and configured credentials (`bun run test:live`). A healthy tenant with no failing rows is valid.

## Pagination and timeouts

Curated collection reads support `--all --max-pages 20`. Single-page output remains the default. Full scans preserve filters and return `results.data` with `scan.pagesFetched` and `scan.complete`. Missing/repeated cursors or exhausted page bounds fail without returning partial results. Auditor scans default to 50 pages; other lists default to 100.

`--timeout-ms 30000` sets the timeout per HTTP request, including token exchange, upload, and download. `--version` prints the installed package version. Help and version output remain text even with `--json`. Empty API success bodies serialize as JSON `null`; JSON downloads require an explicit `--output` file.

### Raw collection scans

Use `raw GET /v1/<collection> --all --max-pages 20 --json` for a bounded scan of a
Vanta collection. This requires the `results.data` and `results.pageInfo` API
response format. Request bodies, multipart inputs, file output and other HTTP
methods cannot combine with `--all`.

The scan preserves query filters, server ordering and an optional starting
`--query pageCursor=<cursor>`. Its `scan.startedAtCursor` is that cursor or `null`.
`scan.complete` means the walk from that position reached the end. A resumed
scan does not represent the rows before its starting cursor. Server changes
during a scan do not provide snapshot consistency.

The aggregate contains `results.data`, a final `pageInfo.hasNextPage: false`, and
`scan` metadata. Endpoint-specific metadata such as `totalCount` is omitted from
aggregates. Single-page reads preserve the original response. Malformed pages,
missing or repeated cursors and exhausted bounds return an error without partial
aggregate output.
