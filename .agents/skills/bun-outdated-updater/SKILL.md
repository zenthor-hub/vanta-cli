---
name: bun-outdated-updater
description: Check or update this repository's Bun dependencies using bun outdated. Use for stale-package reports, dependency refreshes, or semver-compatible dependency bumps while preserving existing version range prefixes. A check-only request does not authorize updates.
---

# Bun Outdated Updater

Dependency versions live in the root `package.json`; this repository has no workspace catalogs.

## Update policy

- Default to the `Update` column. Use `Latest` only when the user explicitly requests latest or major updates.
- Never run bare `bun update`; it can change packages outside the planned scope.
- Preserve each dependency's existing section and version range prefix (`^`, `~`, or no prefix). Do not replace non-semver specifications with registry versions.
- A request to check outdated packages is read-only. For an update request, show the concrete plan before applying it; existing authorization is sufficient for updates within that scope. Ask only when the proposed changes exceed it.
- Keep the Bun runtime requirement and CI version pin separate from package updates unless the user requests a runtime upgrade or an update requires one.

## Workflow

1. Inspect `git status`, `package.json`, and any existing manifest or lockfile changes. Preserve unrelated edits.
2. From the repository root, run:

   ```bash
   bun outdated
   ```

   A non-zero exit can be informational when the output contains valid outdated rows. Registry or authentication failures are errors, not evidence that dependencies are current.

3. Read package, current, update, and latest versions. Strip display-only `(dev)` annotations from package names and locate each dependency in the manifest. Skip rows where `Current` equals the selected target.
4. Show the proposed current-to-target versions and any skipped latest-only updates. For a check-only request, report the findings and stop.
5. For authorized updates, edit only the selected manifest entries to the target versions, preserving their range prefixes. Then synchronize the lockfile:

   ```bash
   bun install
   ```

   If installation fails, stop the update batch, diagnose the failure, and report any remaining blocker. Do not claim the lockfile is synchronized after a failed install.

6. Inspect the manifest and lockfile diff for unintended direct updates or unexpected transitive changes. Run `bun outdated` again to identify remaining updates; do not automatically expand the scope to eliminate every row.
7. Run the repository gate:

   ```bash
   bun run verify
   ```

   Fix regressions caused by the updates within the authorized scope. Live Vanta tests remain opt-in; ordinary dependency verification does not authorize live mutations.

## Report

Summarize updated packages, intentionally skipped updates, and the installation and verification results. Mention unrelated verification failures separately. Commit or push only when requested.
