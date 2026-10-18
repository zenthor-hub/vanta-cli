# Repository skills

`.agents/skills/` is the canonical skill directory. `.claude/skills/` contains relative symlinks; command shims in `.claude`, `.cursor`, and `.opencode` delegate to the canonical instructions.

- `vanta` is the portable CLI companion. The package includes its `SKILL.md`, command guide, and canonical test-description guide under `.agents/skills/vanta/`. Install or link that directory using the chosen agent's skill mechanism. References resolve relative to the skill, independent of the working directory.
- `commit-changes` and `fix-verify` are repository-maintained development workflows.
- `bun-outdated-updater` checks and updates this single-package repository's dependencies. It defaults to Bun's `Update` column, preserves version range prefixes, and verifies authorized updates with `bun run verify`.
- `linear` is a locally maintained adaptation of the OpenAI Linear skill, with its upstream license retained. It discovers the current harness's available tools and honors existing authorization. It is excluded from `skills-lock.json` so upstream skill updates do not overwrite the customization.
- `cli-creator` and `security-best-practices` retain their upstream provenance in `skills-lock.json`. They apply only when their actual triggers match; normal CLI development does not require loading either skill.

`bun run skills:check` validates frontmatter, Claude symlink targets, and local Markdown references. `bun run package:check` installs a tarball into a temporary directory and verifies that the CLI and its companion references work outside the checkout. Both checks run in `bun run verify`.

Keep repeated workflow details in the Vanta reference guides. Root instructions and README examples should summarize and link to those guides. When changing a command or its output contract, update its guide and process-level tests together.
