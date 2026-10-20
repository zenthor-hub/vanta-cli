# Personnel commands

`personnel list` and `personnel get <id>` retain the existing read behavior. The four mutations below dry-run by default. Dry-runs print request plans without token requests or person reads. `--apply` reads the target again and asks for confirmation. `--yes` skips confirmation only when prompt bypass is approved.

## Update metadata

```bash
vanta personnel update PERSON_ID \
  --first-name "Example" --last-name "Person" \
  --employment-start-date 2026-01-01T00:00:00Z --json
```

`--first-name` and `--last-name` require each other. Employment start date can change alone. At least one change is required. Job title and employment status updates are unsupported by this endpoint.

## Set leave

```bash
vanta personnel set-leave PERSON_ID \
  --start-date 2026-11-01T00:00:00Z \
  --end-date 2026-12-01T00:00:00Z --json

vanta personnel set-leave PERSON_ID \
  --start-date 2026-11-01T00:00:00Z --indefinite --json
```

Set-leave replaces existing leave information. Exactly one of `--end-date` or `--indefinite` is required. `--indefinite` sends `endDate: null`. Dates require RFC 3339 seconds and a timezone. The end date cannot precede the start date.

While on leave, the person is inactive in Vanta and excluded from certain personnel-related tests.

## Clear leave

```bash
vanta personnel clear-leave PERSON_ID --json
```

Clear-leave sends no request body. The person becomes active in Vanta and is considered in personnel-related tests.

## Record offboarding completion

```bash
vanta personnel offboard PERSON_ID --acknowledger-id ACKNOWLEDGER_PERSON_ID --json
```

Offboarding requires an explicit acknowledger person ID. Apply-time reads identify both people and display the target's employment and custom offboarding task state before confirmation. Current, upcoming, and on-leave employment states block completion. Visible incomplete tasks, overdue tasks, and tasks due soon also block completion. Missing or malformed prerequisite state fails before the mutation.

`FORMER` and `INACTIVE` are observations rather than proof of complete eligibility. The Person response lacks a complete monitored-account collection. Vanta checks all remaining prerequisites, including monitored-account deactivation. A server rejection exits nonzero even when the HTTP status is 200.

Offboarding completion marks unmonitored accounts deactivated in Vanta. The command does not disconnect external accounts or complete unfinished custom tasks. It sends exactly one update and requires exactly one matching `SUCCESS` result. Missing, extra, duplicate, mismatched, malformed, and per-entry `ERROR` results fail. Server error messages are redacted.

After explicit approval, rerun the same planned command with `--apply`. The success result records acceptance and apply-time observations. The CLI does not read or claim a post-write state.
