# Error Contract

User-facing failures must use a structured error object. A string may be passed inside implementation helpers, but the tool boundary normalizes it before returning JSON to the MCP client. Error types and subtypes are declared in `src/errs/catalog.ts`; the field contract is declared in `src/output/contract.ts`; the runtime shape is `StructuredError` in `src/errs/structured.ts`.

## Error Types

- validation
- workflow_state
- scope
- docs
- verification
- config
- setup
- io
- internal

## Error Subtypes

- `invalid_arguments`
- `invalid_plan`
- `invalid_command`
- `unknown_tool`
- `invalid_phase`
- `invalid_transition`
- `approval_missing`
- `scope_drift`
- `scope_amend_required`
- `docs_missing`
- `docs_stale`
- `sync_missing`
- `check_failed`
- `contract_failed`
- `setup_update_required`
- `setup_artifacts_missing`
- `harness_missing`
- `config_invalid`
- `preflight`
- `client_missing`
- `client_config`
- `client_shadowed`
- `binary_missing`
- `handshake`
- `lock_busy`
- `registry`
- `transaction`
- `postcondition`
- `artifact_drift`
- `identity`
- `ownership`
- `unset`
- `artifact_tracked`
- `package_invalid`
- `io_failure`
- `uncaught_exception`

## Error Envelope Fields

Each returned failure has top-level `ok: false`, `phase`, `next`, and `error`. The nested `error` object contains these stable fields when applicable:

- `type`: broad recovery class from the Error Types list.
- `subtype`: precise recovery reason from the Error Subtypes list.
- `code`: stable programmatic code for a repeated condition.
- `message`: concise user-displayable failure text.
- `hint`: next action guidance for the agent.
- `detail`: structured payload such as validation failures, check output, or missing artifacts.
- `cause`: lower-level cause message when useful.
- `retryable`: whether rerunning the same step may succeed without edits.
- `risk`: risk context for destructive, permission, merge, or release operations.
- `permission_violations`: denied actions, paths, APIs, scopes, or identities.
- `missing_scopes`: auth scopes required to continue.
- `console_url`: URL for CI, cloud, approval, or admin consoles.
- `request_id`: upstream request identifier.
- `trace_id`: distributed trace identifier.

Agents should show `error.message`, add `error.hint` when present, route recovery from `error.type` and `error.subtype`, and include `error.code`, `error.console_url`, `error.request_id`, and `error.trace_id` in troubleshooting output. `permission_violations` and `missing_scopes` require explicit user or operator action; they should not be hidden inside prose.

`setup_update_required` refers to the external deployment selected by the canonical project identity. `setup_artifacts_missing` may refer to that deployment or to the required root `hy-workflow.json`. Recovery is to rerun `hy-workflow setup` from the project. Setup may create or update exactly `hy-workflow.json`, `.github/workflows/hy-workflow.yml`, and the managed `AGENTS.md` block; review and commit those team surfaces through a dedicated setup artifact sync PR. Runtime and client artifacts remain external. Legacy compatibility JSON is read-only migration/drift evidence and is never a lint runtime artifact.

MCP runtime accepts only the root `hy-workflow.json`; legacy user config may be read only by setup/config CLI as a migration input. A missing or invalid root config is therefore a setup/config failure, never permission to fall back to user-local or compatibility JSON. `ROOT_CONFIG_REQUIRED` means the root file is absent; `ROOT_CONFIG_INVALID` also covers runtime-required fields omitted from the raw file even when normalization could infer defaults. A project-local legacy setup stamp never satisfies the external deployment gate.

## Setup failures

Setup and doctor use `type: "setup"` with a stable subtype and code. A setup
result may report success only after its effective client definitions, direct
installed binaries, bounded MCP handshakes, all three team artifacts (`hy-workflow.json`,
`.github/workflows/hy-workflow.yml`, and the managed `AGENTS.md` block), deployment,
registry, and ownership postconditions agree. Important codes include:

- `SETUP_PREFLIGHT_FAILED`, `SETUP_BINARY_MISSING`, and
  `SETUP_HANDSHAKE_FAILED` before any write;
- `SETUP_EFFECTIVE_CONFIG_SHADOWED` when a project/client scope overrides the
  definition setup owns; setup names the source and never deletes it;
- `SETUP_LOCK_BUSY`, `SETUP_REGISTRY_UNREADABLE`, and
  `SETUP_TRANSACTION_FAILED` for external-state integrity failures;
- `SETUP_POSTCONDITION_FAILED` and `SETUP_ARTIFACT_DRIFT` when apply completed
  without proving the effective result;
- `SETUP_IDENTITY_AMBIGUOUS`, `SETUP_OWNERSHIP_CONFLICT`, and
  `SETUP_UNSET_INCOMPLETE` when safe cleanup requires doctor or explicit
  project-id recovery.

Transaction failures expose the journal, affected resources, rollback result,
and exact recovery command. Corrupt or unreadable registry data is never
treated as an empty registry. Dry-run and cancelled TUI flows must leave the
project, OS user roots, and client configuration byte-identical.

Built-in lint failures are returned through the `hy-workflow.lint.v1` report and process exit status. Configuration, unsafe path, zero-scan, and parser/scanner failures produce error findings, normally under D001, C001, or C005, and exit one. Warnings remain visible and exit zero. The engine never writes legacy compatibility JSON, so there is no materialization, cleanup, or recovery-journal error path.

Git/PR recovery is fail closed. `INVALID_GIT_OID`, `GIT_HEAD_OID_MISMATCH`, and `GIT_COMMIT_OID_MISMATCH` stop an unverified or moved commit from being pushed. `COMMIT_RECOVERY_STATE_MISSING` forbids guessing a clean HEAD; `GIT_RECOVERY_OID_MISMATCH` rejects an empty or otherwise moved commit on retry; `VERIFIED_COMMIT_OID_MISSING` blocks CI/merge without the persisted identity. `ORIGIN_REPOSITORY_UNRESOLVED`, `ORIGIN_REPOSITORY_MISMATCH`, and `ORIGIN_REPOSITORY_CHANGED` require origin fetch/push and the persisted selector to name one repository, without trusting `GH_REPO` or `GH_HOST`. `PR_LOOKUP_FAILED`, `PR_LOOKUP_INVALID`, `PR_LOOKUP_AMBIGUOUS`, `PR_IDENTITY_MISMATCH`, and `PR_HEAD_OID_MISMATCH` prohibit create, CI success, or merge while repository/base/head/OID identity is untrusted. `PR_CREATE_UNCONFIRMED` and `PR_CREATE_CONFIRMATION_MISMATCH` mean `gh pr create` output was not confirmed by a second exact lookup.

Merge recovery separates immutable PR identity from mutable lifecycle and persists an attempted receipt before mutation and a confirmed receipt after remote confirmation. `executePrMerge` is the only merge mutation and is never retried inside the helper. Reconciliation first reads the GitHub postcondition; when that evidence is unavailable, `fetchRemoteBaseEvidence` performs **fresh-fetch ancestry** against an immutable `baseOid`. This **read-only Git fallback** can only report `already_integrated` with `evidence: "git"`; it never directly merges or pushes base.

Stable merge recovery codes distinguish uncertainty from unsafe state:

- `MERGE_LOCK_BUSY` means another live owner holds the project-specific merge operation lock. It is retryable after that process finishes. A dead same-host owner may be stale-recovered; owner pid/host/time/token and best-effort token release provide local process coordination, not cross-host strong consistency or power-loss durability.
- `PR_MERGE_OUTCOME_UNCONFIRMED` means neither GitHub nor fresh Git ancestry proved that the verified head is integrated. It stays at merge and never authorizes a second mutation merely because the first command returned an error.
- `POST_MERGE_SYNC_INCOMPLETE` means remote integration is confirmed but base/downstream synchronization is incomplete. `detail.operation: "sync base ancestry"` identifies base ancestry drift; `detail.operation: "downstream snapshot"` identifies a provable legacy stack whose local/remote refs diverged. Other detail names the failed step, branch, completed and remaining work. Retry consumes the confirmed receipt and cannot call the merge mutation again.
- `PR_IDENTITY_MISMATCH`, `PR_HEAD_OID_MISMATCH`, `GIT_EVIDENCE_IDENTITY_MISMATCH`, and `GIT_EVIDENCE_OID_MISMATCH` reject evidence for a different immutable identity. `LOCAL_BRANCH_CAS_FAILED` rejects a moved local ref, while `GIT_FORCE_WITH_LEASE_FAILED` never falls back to an unleased push.

`retryable: false` is a state-integrity decision, not an invitation to repeat `hy_merge`. Inspect the detail, then explicitly use `hy_reset` to abandon the stale receipt or repair state through a reviewed recovery; automatic reset is forbidden. Legacy workflows with no receipt may recognize an already-integrated verified OID, then rebuild only agent-prefix stacks proven by verified ancestry and equal local/remote OIDs. Unrelated branches are ignored; a diverged true stack returns `POST_MERGE_SYNC_INCOMPLETE` without overwriting either ref.

Missing CI evidence is not success. When GitHub reports no checks, or only skipped/neutral checks, `hy_ci` returns `error.code: "CI_CHECKS_REQUIRED"` with a structured stop result, remains in the CI phase, and must not enable `hy_merge`. Recovery is to verify the generated workflow and ask a repository administrator to configure its Verify check as required in a GitHub ruleset or branch protection rule; setup does not make that administrative change.
