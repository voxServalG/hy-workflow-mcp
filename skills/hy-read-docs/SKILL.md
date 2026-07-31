---
name: hy-read-docs
description: Collect bounded local documentation facts before planning, during the automatic pre-approval audit, or after implementation. Use only for the selector and route issued by the CLI.
---

# Read workflow documentation

> **Prerequisite:** Read [`../hy-status/SKILL.md`](../hy-status/SKILL.md) first for the shared CLI authority, exact argv, routing, stop, recovery, and private-state rules.

## Stage command

- The public command is hy-workflow read-docs. Preserve the selector in route.action.input. For before_plan, fill only a required task field from the current concrete user request; never substitute another selector or invent a task.
- Obey route.allowed, route.blocked, route.control, route.userAction, and route.recovery. Read top-level data and error objects as facts.

## Procedure

1. Accept only before_plan, before_approve, or after_edit from route.action.input.
2. For before_plan, include the concrete development task. Follow pagination using the exact returned cursor while more pages remain and the route is current.
3. Use before_approve only after an explicit decision is stored and the CLI routes the automatic audit. This audit is not another human approval gate.
4. Use after_edit only after implementation. Preserve its implementation digest and documentation findings for the synchronization gate.
5. Keep reading bounded to the local documentation system and declared project paths. Do not widen into external systems or replace missing facts with assumptions.
6. Present constraints, terminology, relevant paths, unknowns, and verification expectations from structured facts, then follow the exact route or stop condition.

## Present facts and recover

- Derive the stage purpose from this Skill and the exact selector. Present task and PlanDoc binding, document paths and contents, graph and content digests, traversal roots, budget, pagination, and changedSinceBaseline from machine facts. Do not turn document contents into a new route.
- When pagination reports more content, continue only with the exact cursor and routed selector; restart without a stale cursor only when the route authorizes that recovery.
- Explain missing, empty, unsafe, or invalid documentation from the structured error code, message, detail, and current selector. Request human repair only when the structured user action requires it.
- At before_approve, present the complete PlanDoc decision when approval is still required. After a decision is recorded, treat the audit as automatic. If changedSinceBaseline is true, compare the drift with task, scope, boundary, verification, and risks, then choose only the routed continue or replan path without asking the user to approve the same PlanDoc again.
- At after_edit, report implementation files and digest plus documentation findings. Complete only declared documentation edits before the routed sync-docs command.
