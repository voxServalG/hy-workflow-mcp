---
name: hy-sync-docs
description: Close the documentation synchronization gate after implementation and the after_edit audit. Use when declared documentation edits are complete and the CLI routes edit.sync_docs.
---

# Synchronize documentation evidence

> **Prerequisite:** Read [`../hy-status/SKILL.md`](../hy-status/SKILL.md) first for the shared CLI authority, exact argv, routing, stop, recovery, and private-state rules.

## Stage command

- Invoke hy-workflow sync-docs with no input only when the route permits it.
- Obey route.allowed, route.blocked, route.control, route.userAction, and route.recovery. Read top-level data and error objects as facts.

## Procedure

1. Require current after_edit evidence and finish every documentation or workflow-template edit already declared in PlanDoc scope.
2. Do not ask the command to write documentation. It validates and records evidence only.
3. If the implementation digest changed after the audit, follow the routed audit or edit recovery instead of forcing the gate.
4. Report documentation graph and link findings from structured facts. Hand off to verification only when the route authorizes it.

## Present facts and recover

- Present synced, allowedDocs, implementation digest binding, graph update state, broken-link count, and broken-link details as audit facts. A warning does not authorize an invented route.
- If after_edit evidence is absent or stale, follow the routed read-docs recovery. If configuration is invalid, report the structured error and request repair only when the structured user action requires it.
- Continue to verification only when the returned route is automatic and current.
