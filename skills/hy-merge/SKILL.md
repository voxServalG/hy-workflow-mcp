---
name: hy-merge
description: Reconcile and merge an authorized pull request, then complete the merge.sync downstream stage. Use only after commit.ci is green and the CLI routes merge.reconcile or merge.sync.
---

# Merge and synchronize

> **Prerequisite:** Read [`../hy-status/SKILL.md`](../hy-status/SKILL.md) first for the shared CLI authority, exact argv, routing, stop, recovery, and private-state rules.

## Stage command

- Invoke hy-workflow merge with no input only when the route permits it.
- Obey route.allowed, route.blocked, route.control, route.userAction, and route.recovery. Read top-level data and error objects as facts.

## Procedure

1. Require CLI evidence that the exact pull request and implementation digest passed commit.ci. Do not infer readiness from a browser view or local branch.
2. Invoke only the routed merge argv. Let the CLI reconcile an uncertain remote outcome before retrying; never issue a second direct merge.
3. Treat downstream synchronization as merge.sync within this Skill. Use only the downstream set and recovery facts supplied by the CLI.
4. If merge or synchronization stops, present the remote facts and recovery, then stop. Do not reset while the outcome is unknown.
5. Hand off to reset only after the CLI reports completion and downstream synchronization success.

## Presenting reconciliation and synchronization facts

- Convert structured facts and routes, not Agent prose, into a short explanation. Use stage, status, immutable pull-request identity, data, error, control, and recovery. Never infer a remote outcome or recovery command.
- Always distinguish merge.reconcile from merge.sync. Reconciliation determines whether the exact pull request was integrated; synchronization updates only the recorded base and downstream branches after integration is confirmed.
- For `PR_MERGE_OUTCOME_UNCONFIRMED`, state that neither GitHub nor Git ancestry supplied conclusive evidence. Include the immutable identity from error.detail and wait_and_retry through the routed merge command; never repeat a merge mutation directly.
- For `POST_MERGE_SYNC_INCOMPLETE`, state explicitly that remote integration is already confirmed while local or downstream synchronization remains incomplete. Present data.outcome, data.evidence, data.baseOid, completed, remaining, operation, and branch when supplied. Retrying merge must resume from the receipt and must not merge the pull request again.
- For `MERGE_LOCK_BUSY`, report the safe owner and lock facts, then wait. Do not remove a lock or reset state based only on its age.
- For `MERGE_WORKTREE_NOT_CLEAN` or `DOWNSTREAM_SNAPSHOT_FAILED`, explain the exact pre-mutation condition and relevant branch facts. Make clear whether remote integration was already confirmed before proposing the routed retry.
- For `PR_IDENTITY_MISMATCH` and other non-retryable identity failures, present expected and actual immutable identity facts, then follow reset only when recovery.strategy says reset.
- For every stopped result, present error.code, error.message, retryable status, safe error.detail, and any cause first. Then state route.control reason and the recovery strategy and tool. Stop without guessing from local branch state.
- On completion, report the pull-request number, data.outcome, evidence, baseOid, syncBaseOid, completed downstream branches, remaining branches, and skipped branches. State unavailable fields as unavailable rather than filling them in.

## Completion handoff

- Hand off to reset only when phase and stage report done.completed and route control authorizes reset.
- Do not describe the workflow as complete while any downstream branch remains in data.remaining or while the result is pending or blocked.
