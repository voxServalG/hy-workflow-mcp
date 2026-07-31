---
name: hy-workflow-core
description: Operate the hy-workflow MCP safely in this repository.
---

# hy-workflow Core Skill

## Workflow Order

Use this workflow order for ordinary development: hy_status -> hy_read_docs(before_plan) -> hy_plan -> one user decision submitted to hy_approve -> automatic hy_read_docs(before_approve) -> automatic hy_approve replay when facts are unchanged, or agent hy_approve with auditDecision continue/replan when documents drift -> hy_branch -> hy_edit -> code edits with standard file tools -> hy_read_docs(after_edit) -> declared documentation edits with standard file tools -> hy_sync_docs -> hy_verify -> hy_commit -> hy_merge -> hy_reset.

Never call `hy_read_docs(before_approve)` before the user decision. Call `hy_approve` once with that decision. When the audit is missing, `hy_approve` persists the exact PlanDoc hash, decision, and note and routes the audit automatically. With no drift, the audit returns an automatic replay. With drift, inspect intent, scope, verification, and risks, then call `hy_approve` with `auditDecision=continue` or `auditDecision=replan`. Replan refreshes before_plan and creates a new PlanDoc; it does not fabricate a user revision. Do not ask the user to approve the same PlanDoc again. `hy_edit` only locks scope and stops for real code editing. `hy_read_docs(after_edit)` audits the resulting diff and stops for any documentation edits already declared in PlanDoc. Call `hy_sync_docs` only after those edits are complete; it records evidence and automatically routes verification.

For long-running verify suites (any command estimated >60s, large test layers, or when hy_verify returns a timeout hint), use the async exam path instead of synchronous hy_verify: call hy_exam_plan to get the check manifest and nonces, run each listed command via Bash collecting exitCode plus the last 4KB of output, then call hy_exam_submit with the examId and one complete result set. The exam binds the exact planHash and the full current implementation fingerprint, including untracked content. Submission also requires current approval and document evidence and reruns local scope and no_new_external checks. Both verify paths persist implementationManifest plus verifiedImplementationDigest as the commit gate; verifyHash in a success output or PR label is only a compatibility alias for that digest.

For first setup with both target paths absent, setup creates exactly `hy-workflow.json` and the small exact-version `.github/workflows/hy-workflow.yml` without an artifact-review gate; commit them later through an ordinary focused repository change. If either target is occupied, ordinary setup leaves both untouched and uses complete external configuration. Only the separate `--sync-project-artifacts` operation, combined with acceptance and exact review tuples for every occupied target, may read and replace them. Setup never injects or migrates `AGENTS.md` or project client files; deployment/state/cache/client ownership remains external.

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

Every tool returns an output envelope with `ok`, `phase`, `next`, `status`, `data`, `error`, `display`, `summary`, `hint`, `requires_user`, `stop_here`, `allowedTools`, `blockedTools`, `recovery`, `checks`, `findings`, `pagination`, `meta`, and `_notice` when applicable. `display` contains `title`, `body`, `files`, and `urls`; `recovery` always contains a `strategy` and may contain `tool`, executable `arguments`, `command`, `instruction`, and `byLayer`; `pagination` contains `has_more`, `page_token`, and `next_page_token`; `meta` contains `command`, `cwd`, `identity`, `format`, `version`, `request_id`, `trace_id`, and `duration_ms`; `_notice.update` contains `message`, `command`, `current_version`, and `latest_version`. Errors are structured with `type`, `subtype`, `code`, `message`, `hint`, `detail`, `cause`, `retryable`, `risk`, `permission_violations`, `missing_scopes`, `console_url`, `request_id`, and `trace_id`. Use `message` for user display and `type`/`subtype` for recovery.

## Recovery

Only `userAction.kind=approval` means ask the human to approve; show the full plan summary and bind the decision to its `decisionId` and exact PlanDoc hash. A stored pending decision and the automatic `before_approve` replay never create another approval request. Route recovery by `recovery.strategy`, and when a recovery names an MCP tool, reuse its complete `recovery.arguments` rather than reconstructing or guessing required inputs. `retry` may rerun directly; `repair_and_retry` requires repair first; `wait_and_retry` waits for the named external condition; `replan` revises intent; `reset` explicitly abandons the workflow; `external_action` leaves the MCP pipeline. If verify fails, use recovery and return to edit. If `hy_commit` stage `commit.ci` is pending or has an API problem, wait and retry `hy_commit`; this is not approval. If a permission or auth error includes `permission_violations`, `missing_scopes`, or `console_url`, report those fields clearly before asking the user or operator to act. If `hy_merge`, `hy_reset`, or another destructive step fails, stop and report the structured recovery before doing anything else.

## Long suites

For verify:dev and acceptance, use hy_exam_plan, execute every issued command exactly, and submit every result with hy_exam_submit. Do not send a long suite through synchronous hy_verify. Any failed result returns the workflow to edit; after fixing it, refresh hy_read_docs(after_edit) and hy_sync_docs, then issue a new exam instead of partially resubmitting the old one.
