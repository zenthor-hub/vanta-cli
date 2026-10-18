---
name: fix-verify
description: Identify and fix verification failures in this repo. Use when asked to fix lint, typecheck, formatting, unit test, or `bun run verify` failures. Prefer root-cause fixes and verify with the command that matches the scope of the changes.
---

# Fix Verification

Resolve issues reported by this project's verification commands.

## Workflow

1. Pick the right entrypoint:
   - If the user reports a specific failing command, run that command first.
   - If the scope is unclear, run `bun run verify` from the repo root.
2. Categorize failures by:
   - `oxlint`
   - TypeScript
   - `oxfmt`
   - unit tests
   - skill/package checks and OpenAPI contract validation
   - live CLI smoke checks, only if the user requested them
3. Prefer root-cause fixes over suppressions.
4. Use automatic fixes where appropriate:
   - `bun run oxlint:fix`
   - `bun run oxfmt:fix`
5. Prefer targeted fixes over broad rewrites.
6. Apply targeted manual fixes for anything remaining.
7. Re-run the same verification command that failed first.
8. Before finishing, run the broadest relevant final check, usually `bun run verify`.
9. Stop only when the relevant verification passes or there is a clear blocker.

## Rules

- Never silence errors with `@ts-ignore`, `@ts-expect-error`, `as any`, or unjustified non-null assertions.
- Maintain behavior while fixing analysis issues.
- Do not run Vanta mutations with `--apply` unless the user explicitly asked for a mutation.
- Use `--json` for CLI smoke checks that need parsing.
- Report any remaining non-fixable issue clearly, with file path and reason.

## Output

Report what failed, the root-cause fix, the final command and result, and any remaining blocker. Keep the response proportional to the change.
