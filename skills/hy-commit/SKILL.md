---
name: hy-commit
description: Publish the currently verified implementation and carry commit.ci to a terminal result. Use only in commit.prepare, commit.publish, or commit.ci with current verification evidence.
---

# Commit, publish, and observe CI

> **Prerequisite:** Read [`../hy-status/SKILL.md`](../hy-status/SKILL.md) first for the shared CLI authority, exact argv, routing, stop, recovery, and private-state rules.

## Stage command

- Submit title and body through hy-workflow commit --input <JSON>. Keep the input as one argv value.
- Obey route.allowed, route.blocked, route.control, route.userAction, and route.recovery. Read top-level data and error objects as facts.

## Procedure

1. Require the current verified implementation digest. If files or evidence changed, return through the routed edit and verification path.
2. Provide a concise title and body grounded in the approved PlanDoc and verified facts. Let the CLI stage approved scope, commit, push, and create or reuse the pull request. Never bypass it with direct Git or GitHub publication commands.
3. Treat commit.ci as part of this Skill. For pending checks or a temporary API failure, follow wait_and_retry and repeat only the routed argv.
4. Failed checks return to editing with structured evidence. No checks, skipped-only checks, and neutral-only checks are not success.
5. Continue to merge only when required checks are green and the route authorizes it.

## Presenting commit and CI facts

- Convert structured facts and routes, not Agent prose, into a short explanation. Use stage, status, pull-request identity, data, checks, error, control, and recovery. Never invent a retry command or recovery condition.
- On commit.publish success, identify whether the commit and pull request were created or recovered, include the exact commit object ID and pull-request number or URL when present, and state that CI evidence is still required.
- On commit.ci success, report the pull-request identity, the required Verify result, every effective failed or passed check supplied by the CLI, and that merge is authorized only when the route advances automatically.
- When `COMMIT_ARGUMENTS_MISMATCH` is returned, explain that the persisted intent is bound to the verified implementation. Repeat only recovery.arguments or the exact routed argv; do not synthesize a new title or body.
- When the implementation digest, recovery identity, worktree, or commit object ID differs, explain which expected and actual facts in error.detail differ. Make clear that no push or duplicate commit is permitted and follow the routed edit and verification path.
- For a temporary CI query failure, explain that the recorded commit and pull request remain intact, then stop and retry only the same routed command after the external condition clears.
- For pending checks, state which checks remain pending and the polling timeout when supplied. Wait without requesting a second approval and without creating another commit or pull request.
- For `CI_CHECKS_REQUIRED`, distinguish no checks, a missing trusted Verify run, multiple trusted Verify runs, and skipped or neutral results using the boolean facts and error.code. Explain the required external correction, then stop.
- For failed checks, name failedChecks and relevant check conclusions, explain that the CLI returned to edit, and require fresh local verification before publication resumes.
- For any stopped result, present error.code, error.message, safe error.detail, and retryable status first. Then state route.control reason and the recovery strategy, tool, and exact arguments. Do not turn error text into an unrecorded shell command.
- Never claim that commit, push, pull-request creation, or CI succeeded unless the corresponding data and stage facts say so. Preserve the distinction between a new mutation and a recovered prior mutation.

## Completion handoff

- Continue to the merge Skill only when stage is merge.reconcile, allGreen is true, and the route authorizes it.
- If the route stops in commit.prepare, commit.publish, or commit.ci, explain the facts and wait for the declared recovery condition instead of bypassing the CLI.
