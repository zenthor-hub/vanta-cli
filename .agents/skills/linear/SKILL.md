---
name: linear
description: Manage Linear issues, projects, and team workflows. Use when the user wants to read, create, or update Linear tickets; Vanta data collection belongs to the vanta skill.
metadata:
  short-description: Manage Linear issues using available connected tools
---

# Linear

Use the Linear tools exposed by the current environment. Tool names and installation methods vary by harness; discover the available connector or MCP capabilities before prescribing setup.

If access is unavailable, explain the missing connection and use the current environment's supported connection flow. Do not change global agent settings, install a second integration, or require a restart when an existing connection can do the job.

## Workflows

- Read the relevant issue, team, project, status, and labels before changing them. Resolve missing identifiers through available reads.
- Ask only for information that materially affects the result and cannot be inferred from the request or existing context. Existing authorization remains valid.
- For bulk changes, describe the concrete scope, then execute the authorized updates. Preserve unrelated fields.
- Before creating issues, search for existing matches. For Vanta remediation, preserve the deterministic `ticketKey` and follow the Vanta skill's description-source guide.
- Never close a Vanta remediation issue solely because it disappeared from one query. Verify the source state in Vanta first.
- Read back changed issues to confirm the requested fields and report their links. Distinguish completed updates from blocked or prepared work.

Keep reporting proportional to the request. Do not require a fixed sequence of clarification, planning, setup, and restart for simple reads or already-authorized changes.
