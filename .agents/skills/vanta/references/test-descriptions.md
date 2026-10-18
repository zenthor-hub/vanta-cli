# Vanta Test Descriptions

This repo is used by agents to prepare remediation work from Vanta. When a user asks for a Vanta test "description", they expect the same useful description shown in the Vanta dashboard, not the thin public API summary.

## Source of Truth

Use different sources depending on the row type:

- **Automated tests**: use the Vanta UI test detail source.
- **Document/evidence rows**: use the Vanta document evidence description.

The public Manage API endpoint `/v1/tests/{testId}` is not sufficient for automated test descriptions. Its `description` field can omit the dashboard details that people need to remediate the test.

## Automated Test Description Requirements

For an automated test ticket, include the Vanta UI-backed fields when present:

- `descriptionEnhanced`
- Current failing result descriptors
- Failure text
- Remediation text
- Mapped controls
- Version note
- Vanta metadata: source, ticket key, status, framework, category, owner, and URL

`descriptionEnhanced` is the important field. In the Vanta UI it can include:

- What is the test?
- What are the inputs to the test?
- What is pass and what is fail?
- Key terms
- Relevant documentation

Example: for `approved-gdpr-compliance-policy-exists`, the public API only says the test verifies an approved GDPR Compliance Policy. The UI description also includes the required policy ID, approval requirement, pass/fail criteria, GDPR definitions, help links, current failing result, mapped controls, and the version note about annual renewal checks.

## Document Evidence Description Requirements

For document/evidence tickets, use `/v1/documents/{documentId}` and include:

- `description`
- `uploadStatus`
- `uploadStatusDate` or renewal date
- `renewalCadence`
- category, owner, source, ticket key, and Vanta URL

These rows are evidence requirements, not automated tests. They usually do not have `descriptionEnhanced`.

## Agent Workflow

When preparing or updating Linear tickets from Vanta:

1. Use `dashboard failing-tests` to identify the rows and stable ticket keys.
2. For document rows, fetch `/v1/documents/{documentId}` and use the evidence description.
3. For automated test rows, open the test in the Vanta dashboard through Chrome when UI-backed details are needed.
4. Inspect the Vanta UI detail data for `descriptionEnhanced`, failing result descriptors, remediation, controls, and version notes.
5. Update Linear descriptions with the complete UI-backed text, not only `/v1/tests/{testId}.description`.
6. Keep currently failing Vanta tickets open. Before closing, verify the source directly in Vanta; absence from one API result is not completion evidence.
7. Read back the Linear tickets and verify automated test tickets have `## Vanta test description` and `## Current failing results`.

## Known Vanta UI Detail Fields

The Vanta dashboard test detail view has exposed these useful fields through its UI data:

- `descriptionEnhanced`
- `description`
- `failMessage`
- `failureDescription`
- `remediation`
- `preferredRemediation`
- `versionChangeDescription`
- `controls`
- `failingResourceEntities.edges[].node.descriptor`

These internal UI fields are not part of the stable public Manage API contract. Treat them as dashboard-derived evidence: use them when the user asks for dashboard-matching descriptions, and verify against Chrome if behavior changes.

## Linear Formatting

Use this structure for Linear ticket descriptions:

```md
## Vanta test description

<descriptionEnhanced or best UI-backed test description>

## Failure

<failure text>

## Current failing results

- <failing result descriptor>

## Remediation

<remediation text>

## Mapped controls

- <control id> (<framework>)

## Vanta metadata

- Name: <name>
- Outcome: <outcome>
- Remediation status: <status>
- Frameworks: <frameworks, or "none (not attached to selected frameworks)" when frameworkMatch is none>
- Category: <category>
- Vanta owner: <owner>
- Failing entities: <count>
- Source: tests/<testId>
- Ticket key: vanta:tests:<testId>
- Vanta URL: <url>
```

For document/evidence rows, replace the first heading with `## Vanta evidence description` and omit test-only sections such as mapped controls unless the UI or API explicitly provides them.
