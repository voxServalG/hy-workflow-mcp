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

Every tool returns an output envelope with `ok`, `phase`, `next`, `status`, `data`, `error`, `display`, `summary`, `hint`, `requires_user`, `stop_here`, `allowedTools`, `blockedTools`, `recovery`, `checks`, `findings`, `pagination`, `meta`, and `_notice` when applicable. `display` contains `title`, `body`, `files`, and `urls`; `recovery` contains `tool`, `command`, `instruction`, and `byLayer`; `pagination` contains `has_more`, `page_token`, and `next_page_token`; `meta` contains `command`, `cwd`, `identity`, `format`, `version`, `request_id`, `trace_id`, and `duration_ms`; `_notice.update` contains `message`, `command`, `current_version`, and `latest_version`. Errors are structured with `type`, `subtype`, `code`, `message`, `hint`, `detail`, `cause`, `retryable`, `risk`, `permission_violations`, `missing_scopes`, `console_url`, `request_id`, and `trace_id`. Use `message` for user display and `type`/`subtype` for recovery.

## Recovery

If hy_plan returns `requires_user`, show the full `summary` and wait for approve. If hy_verify fails, use `recovery.byLayer` and return to hy_edit. If hy_ci is pending or has an API problem, stop and retry hy_ci later. If a permission or auth error includes `permission_violations`, `missing_scopes`, or `console_url`, report those fields clearly before asking the user or operator to act. If hy_merge, hy_chain, hy_reset, or another destructive step fails, stop and report the structured recovery instructions before doing anything else.
