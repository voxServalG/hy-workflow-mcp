---
name: hy-verify
description: Complete the authoritative verification gate, including short synchronous checks, long bound exam execution, failures, and explicit scope amendments. Use in verify.run or verify.amendment with current post-edit evidence.
---

# Verify the implementation

> **Prerequisite:** Read [`../hy-status/SKILL.md`](../hy-status/SKILL.md) first for the shared CLI authority, exact argv, routing, stop, recovery, and private-state rules.

## Stage command

- Preserve the route-provided decisionId unchanged in every amend-plan call and fill only the declared human decision field.
- This Skill alone owns hy-workflow verify, hy-workflow exam-plan, hy-workflow exam-submit --input <JSON>, and hy-workflow amend-plan --input <JSON>.
- Keep each JSON input as one argv value. Obey route.allowed, route.blocked, route.control, route.userAction, and route.recovery. Read top-level data and error objects as facts.

## Verification selection

- Small is mandatory for every change: single-module, deterministic and isolated compile, static, type, focused unit, smoke, and pure contract checks near the changed behavior.
- Medium is mandatory when behavior crosses modules, processes, the file system, a local database, serialization, schema, a public API, CLI, configuration, concurrency, or recovery state.
- Large is mandatory for installation, upgrade, packaging, release, CI, cross-platform behavior, an external service, a security boundary, irreversible compatibility, or end-to-end reproduction of a historical major incident.
- The PlanDoc and issued check manifest are the minimum. Never omit an issued check because a smaller level passed.
- At edit.sync_docs, choose only from route.choices: use verify when the complete issued suite is expected to fit the bounded foreground window, or exam-plan when it must run externally. Small, Medium, and Large select test content; they do not determine synchronous versus asynchronous execution.

## Presenting machine facts

- The four verification commands emit structured facts and routes, not Agent prose. Explain those facts in clear language instead of dumping the raw JSON or inventing guidance that is absent from this Skill.
- Treat error code, error message, documentReadHealth, checks, failedChecks, suggestedAmendment, appliedAmendment, decisionId, implementationManifest, verifyHash, examId, issuedAt, expiresAt, scopeFingerprint, nonce, and submitted as machine facts.
- If the CLI routes reset for a missing PlanDoc, invalid scope, or approval mismatch, explain that the state is inconsistent and follow the exact reset route. Verification and amendment commands must never create or replace a PlanDoc approval.
- A stopped userAction with kind approval requires one decision bound to its decisionId and listed options. Present the exact suggestedAmendment and wait for approve, reject, or revise. If userAction is null, do not create another approval gate.
- When verification reaches commit.prepare, report that the bound checks passed and hand off to the commit Skill. Any subsequent implementation edit invalidates that evidence and requires verification again.

## Procedure

1. Use the synchronous verification command only when the complete issued suite fits the bounded foreground window.
2. If documentReadHealth blocks verification, follow its named route. Run after_edit first when required, complete only declared documentation edits, record sync-docs, and then obtain fresh verification evidence.
3. For a long suite or timeout route, request one bound exam manifest. Execute every issued command exactly as printed with its nonce and binding, capture exitCode plus the bounded stdout/stderr tails requested by the manifest, then submit one complete result set. Never manufacture, split, or reuse exam evidence.
4. For scope drift, present the exact amendment and request a decision only when route.userAction requires approval. Apply only the explicit human choice; never self-approve material expansion.
5. On failure, report failed checks and repair only the implicated layer. Return to editing, refresh after_edit and sync-docs evidence, and obtain a new verification or exam binding.
6. Proceed to publication only when the CLI records a current implementation manifest and verified implementation digest.

## Failure guidance

- lint: fix formatting, imports, naming, or static-rule violations without changing business behavior merely to silence lint.
- compile: fix types, imports, exports, or build configuration.
- scope: remove unintended out-of-scope changes. When the CLI returns amend_required, follow the amendment route rather than resetting the whole plan.
- boundary: repair real entry points or module boundaries; never replace a meaningful check with a hollow command.
- platform: repair setup or dependency assumptions; never skip setup silently.
- smoke: repair the smallest executable path exercised by the failed smoke check.
- tests: repair code or tests; never delete a failing test or weaken its assertion merely to turn the result green.

## Exam and amendment recovery

- An issued exam is bound to its exact examId, scope fingerprint, PlanDoc hash, check commands and nonces. Explain its expiry from expiresAt; a changed implementation invalidates the binding.
- A failed exam returns to edit. Repair failedChecks, refresh after_edit and sync-docs evidence, then obtain a new exam. Do not resubmit stale results.
- A non-material scope narrowing reports amended=true and material=false. Explain the appliedAmendment, preserve the original decision identity and follow the automatic re-verification route without asking the user to approve again.
- For AMENDMENT_DECISION_INVALID, map the user's already-issued decision to approve, reject, or revise and retry; do not request a second approval.
- Reject or revise keeps the original PlanDoc approval and returns to edit so the implementation can be restored or the plan revised. Approve applies only the exact pending amendment, then requires after_edit, sync-docs and fresh verification before commit.
- Invalid, empty, external, ignored, local-runtime, or otherwise authority-excluded amendment paths must never be admitted. Explain the structured error and use only the route the CLI exposes.
