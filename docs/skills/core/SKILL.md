---
name: hy-workflow-core
description: Operate the hy-workflow MCP safely in this repository.
---

# hy-workflow Core Skill

## Workflow Order

Use this workflow order for ordinary development: hy_status -> hy_read_docs(before_plan) -> hy_plan -> hy_read_docs(before_approve) -> hy_approve -> hy_branch -> hy_edit -> hy_read_docs(after_edit) -> hy_sync_docs -> hy_verify -> hy_commit -> hy_ci -> hy_merge -> hy_chain -> hy_reset.

For first setup, run hy_init before planning. Do not call approve, branch, edit, verify, commit, CI, merge, chain, or reset out of order.

## Tools

- `hy_init`
- `hy_read_docs`
- `hy_plan`
- `hy_approve`
- `hy_branch`
- `hy_edit`
- `hy_sync_docs`
- `hy_verify`
- `hy_amend_plan`
- `hy_commit`
- `hy_ci`
- `hy_merge`
- `hy_chain`
- `hy_reset`
- `hy_status`

## Output and Error Behavior

Every tool returns an output envelope with ok, phase, next, display, hint, requires_user, stop_here, allowedTools, blockedTools, and recovery when applicable. Errors are structured with type, subtype, and message. Use message for user display and type/subtype for recovery.

## Recovery

If hy_plan returns requires_user, show the full summary and wait for approve. If hy_verify fails, use recovery.byLayer and return to hy_edit. If hy_ci is pending or has an API problem, stop and retry hy_ci later. If hy_merge, hy_chain, hy_reset, or another destructive step fails, stop and report the structured recovery instructions before doing anything else.

