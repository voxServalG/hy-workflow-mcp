# Error Contract

Ordinary failures are structured JSON. Workflow errors appear in `hy-workflow.cli.v1`; helper errors appear in `hy-workflow.helper.v1`. A caller must use `error.type`, `error.subtype`, `error.code`, `error.retryable` and route fields rather than scraping the message.

## Workflow error shape

```json
{
  "ok": false,
  "phase": "verify",
  "stage": "verify.run",
  "status": "failed",
  "error": {
    "type": "verification",
    "subtype": "check_failed",
    "code": "CHECK_FAILED",
    "message": "One or more required checks failed.",
    "detail": {},
    "retryable": false
  },
  "route": {
    "action": {
      "command": "edit",
      "argv": ["hy-workflow", "edit"]
    },
    "control": {
      "stop": true,
      "reason": "repair_required"
    }
  }
}
```

Error fields may include `detail`, `cause`, `risk`, `permission_violations`, `missing_scopes`, `console_url`, `request_id` and `trace_id`. The CLI adapter removes prompt-like `hint` text from the public error. The current Skill explains recovery from structured fields and the mapped route.

Broad workflow types include validation, workflow state, scope, docs, verification, config, setup, I/O and internal errors. Stable subtypes distinguish invalid arguments/phase/transitions, missing approval, scope drift/amendment, stale documentation, failed checks, invalid config, ownership/identity, transaction/postcondition and I/O failures.

The complete compatibility subtype inventory is:

- `invalid_arguments`, `invalid_plan`, `invalid_command`, `unknown_tool`;
- `invalid_phase`, `invalid_transition`, `approval_missing`;
- `scope_drift`, `scope_amend_required`;
- `docs_missing`, `docs_stale`, `sync_missing`;
- `check_failed`, `contract_failed`;
- `setup_update_required`, `setup_artifacts_missing`, `harness_missing`;
- `config_invalid`, `preflight`;
- `client_missing`, `client_config`, `client_shadowed`;
- `binary_missing`, `handshake`, `lock_busy`, `registry`;
- `transaction`, `postcondition`, `artifact_drift`, `identity`, `ownership`;
- `unset`, `artifact_tracked`, `package_invalid`, `io_failure`, `uncaught_exception`.

Some names survive from the previous transport as kernel compatibility values. Public Skills route from the current CLI command and structured recovery; they never try to call an `unknown_tool` or rebuild an obsolete transport action.
`APPROVAL_DECISION_ID_MISMATCH` and `AMENDMENT_DECISION_ID_MISMATCH` mean a response was issued for a different PlanDoc or pending amendment. They are retryable only by refreshing `status`, presenting the current decision, and returning its exact signed `decisionId`; the rejected call does not mutate workflow state.


## CLI input errors

Input is rejected before dispatch with stable codes such as:

- `COMMAND_MISSING`, `COMMAND_UNKNOWN`;
- `OPTION_UNKNOWN`, `OPTION_REPEATED`, `OPTION_VALUE_MISSING`;
- `INPUT_SOURCE_CONFLICT`, `INPUT_TOO_LARGE`;
- `INPUT_JSON_INVALID`, `INPUT_JSON_NOT_OBJECT`, `INPUT_JSON_NON_FINITE`, `INPUT_JSON_UNSUPPORTED_VALUE`;
- `INPUT_FILE_UNREADABLE`, `INPUT_FILE_UNSAFE`;
- `INPUT_UNKNOWN_FIELDS`, `INPUT_SCHEMA_INVALID`.

These errors are non-retryable until the argv/input is corrected. The failure envelope routes to `status` so the caller can refresh its position after repair.

## Helper error shape

Helper top-level status is `attention`, `partial` or `failed` when `ok` is false. Each `skills`, `project` and `mcp` layer retains its own status. A partial result includes the exact retry argv and completed layer names; retry is safe only after addressing the named error.

Argument and selection codes include:

- `HELPER_COMMAND_MISSING`, `HELPER_COMMAND_UNKNOWN`;
- `HELPER_OPTION_UNKNOWN`, `HELPER_OPTION_REPEATED`, `HELPER_OPTION_VALUE_MISSING`, `HELPER_OPTION_NOT_ALLOWED`;
- `HELPER_CLIENTS_INVALID`, `HELPER_CLIENTS_NOT_DETECTED`, `HELPER_CLIENT_PATH_UNAVAILABLE`;
- `HELPER_MODE_INVALID`, `HELPER_MODE_IMMUTABLE`, `HELPER_TARGET_SET_IMMUTABLE`;
- `HELPER_SKILLS_NOT_INSTALLED`, `HELPER_STATUS_ATTENTION`.

Skill ownership and transaction codes include:

- `HELPER_SKILL_BUNDLE_INVALID`, `HELPER_SKILL_MANIFEST_INVALID`, `HELPER_SKILL_NOT_INSTALLED`;
- `HELPER_SKILL_NO_TARGETS`, `HELPER_SKILL_PATH_UNSAFE`, `HELPER_SKILL_BUSY`, `HELPER_OPERATION_BUSY`;
- `HELPER_SKILL_OWNERSHIP_CONFLICT`, `HELPER_SKILL_ROLLBACK_CONFLICT`.

Project/migration codes include:

- `HELPER_PATH_UNSAFE`, `HELPER_PROJECT_CONFIG_INVALID`;
- `HELPER_DEPLOYMENT_IDENTITY_MISMATCH`, `HELPER_DEPLOYMENT_REGISTRY_MISMATCH`, `PROJECT_IDENTITY_CONFLICT`;
- `HELPER_MCP_OWNERSHIP_INVALID`, `HELPER_MCP_RETIREMENT_INCOMPLETE`, `HELPER_SKILL_STATE_CHANGED`.

An ownership conflict is never permission to overwrite or delete. Inspect the exact path and manifest facts. Use `update --repair` only for an intentionally missing owned projection, not for unmanaged drift.
`HELPER_OPERATION_BUSY` indicates another install/update/remove owns the complete helper lifecycle; status remains read-only and available. `HELPER_SKILL_STATE_CHANGED` prevents legacy MCP retirement when installed Skills no longer match the just-produced manifest. A registry/deployment mismatch is an integrity failure and must not be repaired by overwriting either private file.


## Setup-gate failures

Workflow commands require a valid external deployment and configuration. Missing registration, invalid configuration or ambiguous identity stays at a safe phase and blocks planning/mutation. Recovery is `hy-workflow helper install` or the exact helper route, not creating `hy-workflow.json`, a workflow file or an MCP entry by hand.

`init` never invokes helper implicitly. This keeps installation authority, project cognition and workflow state transitions separate and auditable.

## Verification recovery

A failed check routes to edit. Repair only the named layer, then refresh `read-docs(after_edit)` and `sync-docs` before obtaining new verification evidence. An asynchronous exam is bound to one implementation fingerprint; after any repair, issue a new exam rather than resubmitting part of the old one.

Successful synchronous verify or successful exam submission clears a stale commit-recovery record. A failed attempt must not clear it, because the existing exact commit may still need reconciliation.

## Commit, PR and CI integrity

Commit/PR recovery is fail closed. Representative codes include invalid or moved Git OIDs, missing/mismatched commit recovery, unresolved or changed origin repository, ambiguous PR lookup, PR identity/head mismatch and unconfirmed PR creation.

Do not repair these by manufacturing an empty commit, changing `GH_REPO`, or retrying a movable branch push. Refresh status and follow the exact route. The CLI only reuses a commit when branch, base, repository, verified digest and HEAD match the persisted record.

Missing CI evidence is not success. `CI_CHECKS_REQUIRED` means no effective checks, or only neutral/skipped evidence, satisfied the active policy. The repository team must provide and configure real checks in its own CI; helper does not inject them. Failed checks return to edit, while pending or temporary API errors remain in `commit.ci` and use wait-and-retry.

## Merge recovery

`MERGE_LOCK_BUSY` means another local owner currently holds the merge operation lock. Wait and retry only as routed.

`PR_MERGE_OUTCOME_UNCONFIRMED` means neither GitHub state nor fresh Git ancestry proves integration. Do not issue another direct merge. Retry `merge` only when the route says reconciliation is safe.

`POST_MERGE_SYNC_INCOMPLETE` means integration is confirmed but base/downstream synchronization has unfinished work. The confirmed receipt prevents a second merge mutation; retry continues only remaining sync steps.

Immutable PR/OID mismatch, local compare-and-swap failure or remote force-with-lease drift is a state-integrity problem. A non-retryable result requires inspection and an explicit reviewed decision; it is not an invitation to loop or reset automatically.

## Operator rule

Never edit private workflow state, project registry, Skill ownership manifest or recovery receipts to suppress an error. When a code is not understood, run `hy-workflow status` or `hy-workflow helper status --json`, preserve the full structured envelope and investigate the recorded identities before mutation.
