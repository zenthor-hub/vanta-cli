# Vulnerability command reference

Vulnerability reads use the Manage API and the selected profile. Existing `vulnerabilities list` and `vulnerabilities get <id>` behavior is unchanged.

## Asset and remediation reads

```bash
vanta vulnerabilities assets list --all --max-pages 10 --query assetType=SERVER --json
vanta vulnerabilities assets get ASSET_ID --json
vanta vulnerabilities remediations list --all --max-pages 10 --query severity=HIGH --json
```

Asset commands use `/v1/vulnerable-assets`. Remediation commands use `/v1/vulnerability-remediations`. Lists accept repeatable `--query key=value`, `--all`, and `--max-pages` from 1 to 100. Single-page reads remain the default. Repeated query values and server ordering are preserved.

## Monitoring exceptions

```bash
vanta vulnerabilities deactivate VULN_ID \
  --reason "Accepted risk until the dependency upgrade" \
  --reactivate-when-fixable true \
  --until 2099-12-31T23:59:59Z \
  --json
vanta vulnerabilities reactivate VULN_ID --json
```

Deactivation requires a nonempty `--reason` and an explicit `--reactivate-when-fixable true|false`. `--until` must be a future RFC 3339 date-time with seconds and a timezone. Omitted expiry is omitted from the request. The CLI does not infer a server-confirmed indefinite exception from that omission.

Both commands are dry-run by default. Dry-runs print the one-item request plan and perform no token or API requests. Explicit approval is required before adding `--apply`. Confirmation remains required unless skipping it with `--yes` was approved.

At apply time, the CLI reads the vulnerability by its encoded ID and validates documented deactivation metadata before confirmation. Missing, mismatched, contradictory, or expired state fails before the write. Reactivation returns `noChange: true` when the read explicitly returns `deactivateMetadata: null`.

Deactivation sends the requested settings even when the reason and expiry appear unchanged. Vanta does not return `shouldReactivateWhenFixable` in its vulnerability read metadata, so the CLI cannot prove that every setting matches. A successful write means Vanta accepted the update. The CLI does not poll or claim an immediate post-write state.

## SLA miss acknowledgement

```bash
vanta vulnerabilities remediations acknowledge-sla-miss REMEDIATION_ID \
  --comment "Dependency release delayed" \
  --query severity=HIGH \
  --max-pages 10 \
  --json
```

`--comment` is required and must not be empty. Dry-run and approval rules match monitoring exceptions.

Before applying, the CLI scans remediation pages until it finds the requested ID. `--query` accepts `integrationId`, `severity`, `isRemediatedOnTime`, `remediatedAfterDate`, `remediatedBeforeDate`, `pageSize`, and a single `pageCursor`. The API has neither a remediation GET endpoint nor an ID filter.

The scan stops when the ID is found. If the scan reaches `--max-pages` while another page exists, the command fails with a safety-limit error. If the filtered scan completes without a match, the error reports that outcome separately. A starting cursor limits that conclusion to the remaining collection. A filtered miss does not prove that the record is absent from Vanta.

The lookup proves existence only. Vanta checks whether the remediation can receive an SLA acknowledgement.

## Mutation results

Each mutation sends one `updates` entry and requires exactly one response result with the matching ID and status `SUCCESS` or `ERROR`. Empty, duplicate, extra, mismatched, unknown-status, and malformed results fail. An `ERROR` entry requires its documented message field and exits nonzero even when HTTP status is 200. Output redacts the server message and identifies the requested ID and `BulkUpdateError`.

Local HTTP fixture tests cover request emission and result handling. They do not establish tenant permissions, account eligibility, or actual server state changes.
