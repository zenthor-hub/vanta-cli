---
name: commit-changes
description: Create small, logical git commits from current repo changes. Use when asked to commit work, package staged or unstaged changes into sensible commits, or review local diffs before committing. This repo verifies with `bun run verify`. Requires showing a commit breakdown before creating commits.
---

# Commit Changes

Create small, focused commits from the current worktree.

## Workflow

1. Review the state first:
   - Run `git status` to see all modified, staged, and untracked files.
   - Run `git diff`, `git diff --cached`, and `git diff --stat` to understand the actual change set.
2. Check for local-only artifacts before committing:
   - debug logging
   - hardcoded test values or local paths
   - commented-out code
   - temporary helpers or local config
   - unjustified `@ts-ignore`, `@ts-expect-error`, `as any`, or non-null assertions
   - Vanta mutations run with `--apply` unless explicitly requested by the user
3. Group the changes into the smallest logical commits.
4. Verify with `bun run verify` from the repo root.
   - Do not use CLI smoke commands as a replacement for verification.
   - Do not stage or commit anything if verification is failing unless the user explicitly authorizes committing known failures.
   - If verification already passed, note which run confirmed it in the commit plan.
5. Present the proposed commit plan to the user before executing any `git commit`.
6. Unless the user explicitly says not to commit yet, stage and commit each group after presenting the plan.
7. Show `git log --oneline -n <count>` for the new commits.
8. Push only when already authorized by the user. Otherwise report that the commits remain local.

## Commit Rules

- Use conventional commit format. Prefer `type: description`; add a scope only when it is useful.
- Prefer `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, and `style`.
- Plain `git commit` is non-destructive in this workflow and does not require separate approval once the user has asked to commit and the commit plan has been shown.
- Reserve explicit approval checks for destructive git actions such as `git reset --hard`, `git checkout -- <path>`, `git clean -xfd`, rebases, amends, force pushes, or other history rewrites/discard operations.
- Never add Claude/Codex attribution or co-author lines unless explicitly requested.
- Never amend or rewrite history unless the user explicitly asks.
- Do not commit unrelated user changes as part of a cleanup pass.
- If `.agents/skills/**`, `.claude/skills/**`, command shims, or `skills-lock.json` changed together, commit them together as one logical skill-management change.
- Include `.vscode` and `.zed` updates by default unless the user explicitly says to exclude them.
- Never commit secrets or local env files such as `.env*`, OAuth credentials, or API keys without explicit user approval.

## Output

- Show the repo status and a concise commit breakdown first.
- Mention whether validation already ran, and if so which command and working directory were used.
- Treat the commit plan as notice, not an approval gate, unless the user asked to review first or pause before committing.
- After committing, report the commit hash and message for each new commit.
