---
name: hy-workflow-core
description: Operate the hy-workflow MCP safely in this repository.
---

# hy-workflow Core Skill

## Workflow Order

Use this workflow order for ordinary development: hy_status -> hy_read_docs(before_plan) -> hy_plan -> hy_read_docs(before_approve) -> hy_approve -> hy_branch -> hy_edit -> hy_read_docs(after_edit) -> hy_sync_docs -> hy_verify -> hy_commit -> hy_merge -> hy_reset.

For long-running verify suites (any command estimated >60s, large test layers, or when hy_verify returns a timeout hint), use the async exam path instead of synchronous hy_verify: hy_exam_plan to get the check manifest and nonces, run each listed command via Bash collecting exitCode + last 4KB stdout, then hy_exam_submit with the examId and results. Both paths produce a verifyHash that unblocks hy_commit.

For first setup, review and commit exactly `hy-workflow.json` and the small exact-version `.github/workflows/hy-workflow.yml`, restart the client, then run hy_init. Setup never injects or migrates `AGENTS.md` or project client files; deployment/state/cache/client ownership remains external.

Documentation gates are mandatory and indivisible. Reads are task-ranked and budgeted; follow `pagination.nextCursor` when `hasMore`, while workflow state stores metadata/digests rather than excerpts. Generated Verify uses pinned checkout, read-only contents, and the exact package version for centralized lint/policy. It does not infer ecosystems, install toolchains, run native CI, or embed the former large bundle. Zero scans, parser/report errors, no checks, or non-success checks block merge. An administrator, not setup, makes Verify required.

## Tools

- `hy_init`
- `hy_read_docs`
- `hy_plan`
- `hy_approve`
- `hy_branch`
- `hy_edit`
- `hy_sync_docs`
- `hy_verify`
- `hy_exam_plan`
- `hy_exam_submit`
- `hy_amend_plan`
- `hy_commit`
- `hy_merge`
- `hy_reset`
- `hy_status`

## Output and Error Behavior

Every tool returns an output envelope with `ok`, `phase`, `next`, `status`, `data`, `error`, `display`, `summary`, `hint`, `requires_user`, `stop_here`, `allowedTools`, `blockedTools`, `recovery`, `checks`, `findings`, `pagination`, `meta`, and `_notice` when applicable. `display` contains `title`, `body`, `files`, and `urls`; `recovery` contains `tool`, `command`, `instruction`, and `byLayer`; `pagination` contains `has_more`, `page_token`, and `next_page_token`; `meta` contains `command`, `cwd`, `identity`, `format`, `version`, `request_id`, `trace_id`, and `duration_ms`; `_notice.update` contains `message`, `command`, `current_version`, and `latest_version`. Errors are structured with `type`, `subtype`, `code`, `message`, `hint`, `detail`, `cause`, `retryable`, `risk`, `permission_violations`, `missing_scopes`, `console_url`, `request_id`, and `trace_id`. Use `message` for user display and `type`/`subtype` for recovery.

## Recovery

Only `userAction.kind=approval` means ask the human to approve; show the full plan summary and bind the decision to its `decisionId` and exact PlanDoc hash. If verify fails, use recovery and return to edit. If `hy_commit` stage `commit.ci` is pending or has an API problem, wait and retry `hy_commit`; this is not approval. If a permission or auth error includes `permission_violations`, `missing_scopes`, or `console_url`, report those fields clearly before asking the user or operator to act. If `hy_merge`, `hy_reset`, or another destructive step fails, stop and report the structured recovery instructions before doing anything else.

## Long suites

For verify:dev and acceptance, use hy_exam_plan, execute every issued command exactly, and call hy_exam_submit. Do not send a long suite through synchronous hy_verify.
