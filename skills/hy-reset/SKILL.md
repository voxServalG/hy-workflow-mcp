---
name: hy-reset
description: Clear workflow derivations after completed merge synchronization or explicitly abandon the current task as a recovery action. Use only when the CLI route permits reset.
---

# Reset workflow state

> **Prerequisite:** Read [`../hy-status/SKILL.md`](../hy-status/SKILL.md) first for the shared CLI authority, exact argv, routing, stop, recovery, and private-state rules.

## Stage command

- Invoke hy-workflow reset with no input only when the route permits it.
- Obey route.allowed, route.blocked, route.control, route.userAction, and route.recovery. Read top-level data and error objects as facts.

## Procedure

1. For normal completion, require CLI evidence that merge and downstream synchronization are complete.
2. Before completion, require an explicit human abandonment request whenever route.userAction asks for it. Explain which plan, approval, verification, and merge derivations will be cleared.
3. Invoke only the routed reset argv. Do not delete project files, branches, pull requests, user edits, configuration, or Git metadata as a substitute.
4. If a remote outcome is unknown, reconcile it through the routed publication or merge recovery before reset.
5. Report the resulting planning position and next permitted route from the CLI envelope.

## Present facts and recover

- After reset, report the returned planning phase and before_plan stage as authoritative facts. Explain that workflow derivations were cleared without claiming deletion of repository files, branches, pull requests, or Git history.
- For a new task, obtain the concrete request and hand it to the exact routed read-docs command; do not infer a PlanDoc or approval.
