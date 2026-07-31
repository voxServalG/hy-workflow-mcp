# Verification Pipeline

Verification has two equivalent evidence paths. `hy-workflow verify` runs the synchronous suite issued for the current PlanDoc. `exam-plan` plus `exam-submit` handles long suites outside one foreground CLI call. Both require current `read-docs(after_edit)` and `sync-docs` evidence, recheck scope/boundary invariants, and persist the same canonical `implementationManifest` plus `verifiedImplementationDigest` on success.

The CLI is completeness authority for the issued manifest and recorded results. The `hy-plan` and `hy-verify` Skills decide which Small, Medium and Large checks are semantically required from the project/change facts.

## Semantic scales

- Small is mandatory for every change: static/type/contract checks and focused unit or smoke tests around changed deterministic behavior.
- Medium is mandatory when work crosses modules, processes, filesystem/local database, serialization/schema, public API, CLI, configuration, concurrency or recovery state.
- Large is mandatory for installation, upgrade, packaging, release, CI, cross-platform behavior, external services, security boundaries, irreversible compatibility or historical incidents needing end-to-end reproduction.

Scale describes the boundary under test, not duration. The PlanDoc names concrete commands and expected exits. Passing a smaller scale never waives a required larger scale.

## Synchronous layers

```text
compile
  -> language/compiler checks derived from selected runtime config and project files
scope
  -> tracked, indexed and untracked changes are exactly within approved scope
boundary
  -> declared entry points and no-new-external policy
platform
  -> required runtime versions and setup commands
smoke
  -> fast behavior checks with exact expected exits
tests
  -> PlanDoc test commands with exact expected exits
```

All hard checks must pass. Soft checks are explicit warnings, not missing evidence disguised as success. An actual exit code must equal `expected_exit`; any other code fails even when both are nonzero.

The Agent should include `hy-workflow lint --json` as a local PlanDoc entry point when doclint/codelint applies. Lint is a first-party CLI command, not an automatically injected GitHub job. Dependency-graph lint is not provided.

## Compile behavior

Compile discovery uses the selected runtime configuration's `project.codeExt` and `project.codeDirs`, regardless of whether those values originated in fresh external detection or preserved compatible state.

- TypeScript/TSX runs the configured TypeScript compile path, normally `npx tsc --noEmit`.
- JavaScript-only projects without an explicit TypeScript config may soft-skip compile rather than requiring TypeScript.
- Python enumerates configured roots and relevant top-level Python files, then uses structured executable/argv invocation for `py_compile` behavior.
- Mixed projects run every relevant built-in compile check.
- Unknown extensions without a built-in compiler do not fabricate a compiler; the PlanDoc must provide appropriate entry points when required.

## Scope and dependency boundary

Scope compares changes relative to the selected base branch, index state and untracked files with `changes`, `new_files` and `delete`. Extra safely amendable paths can route to `verify.amendment`; missing required paths or unsafe additions fail.

When `boundary.no_new_external` is true, Node dependency-bearing sections, lockfiles and common ecosystem dependency manifests cannot change. Node scripts/version/bin/files metadata are not dependencies merely because they live in `package.json`. Relevant files include Node lockfiles, Python requirements/lock/config files, Cargo manifests/lock, Go modules/sums, Composer and Gem manifests/locks, and declared policy manifests.

If the Git baseline or implementation manifest cannot be constructed, boundary verification fails closed. Setting `no_new_external: false` is an explicit PlanDoc decision and does not bypass scope or test evidence.

## Synchronous command supervision

The synchronous path uses an asynchronous cross-platform process supervisor with command-specific timeouts. Timeouts are explicit failed checks. Cleanup terminates the spawned process group on POSIX or the process tree on Windows so a timed-out npm shell cannot keep mutating output or holding the worktree.

Commands expected to exceed the foreground budget belong in the exam path. Duration alone does not change their Small/Medium/Large classification.

## Asynchronous exam path

`hy-workflow exam-plan` returns an exam ID with TTL and a complete list of checks. Each item binds its ID, layer, exact command, timeout, expected exit, nonce and optional output constraint to the current PlanDoc hash and full implementation fingerprint, including untracked content.

The Skill executes every command exactly once through a structured process API, records the requested bounded stdout/stderr evidence, and submits one complete JSON result set to `hy-workflow exam-submit`. Submission verifies:

- exam validity and exact PlanDoc hash;
- unchanged implementation fingerprint;
- complete IDs, commands and nonces;
- exact exits and required output;
- current approval and documentation evidence;
- local scope and `no_new_external` boundary.

Any failure returns to edit. After repair, refresh `read-docs(after_edit)` and `sync-docs`, then issue a new exam. Partial resubmission or reuse of the old binding is forbidden.

## Evidence and stale commit recovery

On success, both paths persist the current path/content manifest and its `verifiedImplementationDigest`. Commit reconstructs the manifest before staging/publishing and requires an exact match. Compatibility values named `verifyHash` or `verifiedManifestHash` are aliases/legacy fields, not separate authority.

A successful synchronous verification or exam submission removes a stale commit-recovery record before writing the new verified state. This is required after a failed CI/commit attempt is repaired. Failed, timed-out or incomplete verification does not clear the record.

## Result model

Each check carries at least layer, name, pass/fail detail and hard/soft classification. The aggregate report carries `allPassed`, `hardFailed`, total and ordered checks. CLI projection exposes these as fact fields while routing failures back to edit and success to commit.

The Skill explains expected versus observed results from structured facts. It does not treat candidate commands from `init` as executed evidence.

## CI boundary

Local verification and GitHub CI are separate evidence sources. Helper never creates a workflow. A consuming repository decides whether to call `hy-workflow lint --json`, how to install native toolchains and which checks are required.

During `commit.ci`, the kernel observes the exact PR and effective checks required by the active project policy. Failure returns to edit. Pending/API uncertainty stays in commit and uses wait/retry. No checks or only skipped/neutral checks produce `CI_CHECKS_REQUIRED` when CI evidence is required. This observation contract does not imply that setup installed those checks.

## Built-in lint report

`hy-workflow lint --json` emits `hy-workflow.lint.v1`, version 1, with deterministic ordered checks, sorted findings and aggregate counts. Status may be `passed`, `failed`, `warning`, `not_applicable` or `not_configured`. Warnings exit zero; errors, invalid configuration, supported-language parser/scanner failure and configured zero-scan conditions exit one. The engine does not write compatibility JSON.

See [Built-in Lint Rules](./lint-rules.md), [State Machine](./state-machine.md), and [Command Reference](./tools.md).
