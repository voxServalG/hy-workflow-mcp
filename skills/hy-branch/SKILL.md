---
name: hy-branch
description: Create the implementation branch authorized by the approved PlanDoc and current CLI state. Use only at branch.create with an allowed category and safe topic.
---

# Create the implementation branch

> **Prerequisite:** Read [`../hy-status/SKILL.md`](../hy-status/SKILL.md) first for the shared CLI authority, exact argv, routing, stop, recovery, and private-state rules.

## Stage command

- Submit category and topic through hy-workflow branch --input <JSON>. Keep the input as one argv value.
- Obey route.allowed, route.blocked, route.control, route.userAction, and route.recovery. Read top-level data and error objects as facts.

## Procedure

1. Require current approval evidence bound to the exact PlanDoc and an allowed branch route.
2. Use only an allowed category and a lowercase kebab-case topic. Reuse routed input when supplied.
3. Let the CLI validate refs and create the branch from its configured base. Do not bypass it with direct Git checkout, switch, or branch commands.
4. Report the structured branch fact and continue to the routed scope lock. On failure, stop and present the exact recovery facts.

## Present facts and recover

- On success, report the exact created branch and hand off to the routed edit scope lock.
- On failure, report error type, subtype, code, message, detail, cause, and retryability without importing embedded Git remediation prose. Preserve recovery strategy, tool, and exact category/topic arguments.
- Stop for the structured configuration action and retry only through the returned route. Never execute an example shell command inferred from an error.
