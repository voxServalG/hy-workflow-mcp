# State Machine

The CLI preserves the workflow kernel's existing phases and fine-grained stages. Skills have the same names as the human-visible phases where possible, but a Skill never owns state. It reads a current CLI envelope and follows only its exact route.

## Phases and stages

| Phase | Stages | Primary Skill | Purpose |
|---|---|---|---|
| `init` | `init.ready` | `hy-init` | Validate external readiness and collect local project cognition. |
| `plan` | `plan.before_plan`, `plan.compose`, `plan.review` | `hy-read-docs`, `hy-plan` | Ground and compile one PlanDoc. |
| `approve` | `approve.before_approve`, `approve.decision` | `hy-approve`, `hy-read-docs` | Bind one human decision and audit current facts. |
| `branch` | `branch.create` | `hy-branch` | Create the approved implementation branch. |
| `edit` | `edit.scope`, `edit.implementation`, `edit.after_edit`, `edit.sync_docs` | `hy-edit`, `hy-read-docs`, `hy-sync-docs` | Lock scope, implement and bind documentation evidence. |
| `verify` | `verify.run`, `verify.amendment` | `hy-verify` | Prove the implementation or review scope amendment. |
| `commit` | `commit.prepare`, `commit.publish`, `commit.ci` | `hy-commit` | Create the exact commit, publish/reuse the PR and observe CI. |
| `merge` | `merge.reconcile`, `merge.sync` | `hy-merge` | Reconcile the merge outcome and synchronize downstream branches. |
| `done` | `done.completed` | `hy-reset` | Preserve terminal evidence until reset. |

Workflow status is one of `ready`, `running`, `passed`, `warning`, `pending`, `blocked`, `failed`, `completed`, or the compatibility value `amend_required`. Status describes the current condition; it never grants permission by itself. Permission comes from `route.allowed`, `route.blocked` and the exact route action.

## Normal route

```text
init.ready
  -> plan.before_plan
  -> plan.compose
  -> plan.review
  -> approve.before_approve / approve.decision
  -> branch.create
  -> edit.scope
  -> edit.implementation
  -> edit.after_edit
  -> edit.sync_docs
  -> verify.run [-> verify.amendment -> edit.implementation]
  -> commit.prepare
  -> commit.publish
  -> commit.ci
  -> merge.reconcile
  -> merge.sync
  -> done.completed
  -> reset -> plan.before_plan
```

The public command sequence is:

```text
init
status
read-docs -> plan
approve -> read-docs -> approve continuation or replan
branch -> edit
[normal file edits] -> read-docs -> [declared documentation edits] -> sync-docs
verify | exam-plan + exam-submit | amend-plan
commit
merge
reset
```

There is no separate public `ci` command: `commit` owns `commit.ci`. There is no separate public `chain` command: `merge` owns `merge.sync`.

## Route authority

Every CLI response contains:

- the current `phase`, `stage` and `status`;
- `route.allowed` and `route.blocked` command names;
- `route.action.command` and exact `route.action.argv` when an executable next action exists;
- `route.control`, including whether execution must stop;
- a structured `route.userAction` when a person or external action is required;
- structured recovery facts when the normal route cannot continue.

A Skill calls `status` unless the immediately previous envelope routes its exact command and is still current. It must not reconstruct a route from this document, conversation history or private files. When `route.control.stop` is true, an `automatic` action is not permission to ignore the stop reason.

## Initialization

`init` is idempotent with respect to an already active workflow. In `init` or `plan`, it validates deployment/config readiness, collects local cognition, writes only external state and routes to `plan.before_plan`. In a later phase it leaves the workflow unchanged and routes to status rather than restarting it.

Missing or unsafe external deployment blocks planning. `init` never starts an installer, writes the worktree, writes `.git`, contacts an external knowledge service or fetches remote history.

## Planning and one approval

`read-docs` at `before_plan` binds the current task to local documentation facts. `plan` validates and stores the PlanDoc, then stops for a human decision.

The `approve` flow has one human gate:

1. The user explicitly says approve, reject or revise for the displayed PlanDoc.
2. The Skill submits that exact decision once.
3. If current `before_approve` evidence is missing, CLI persists the pending decision and routes the documentation audit.
4. No material drift means the same decision may continue automatically.
5. Material drift requires a routed `continue` or `replan` judgment from the Skill. This is an evidence-alignment decision, not a second human approval.
6. A changed PlanDoc must return to a new human decision.

Approval cannot be inferred from task wording, a previous task, silence or a generic request to continue.

## Editing and documentation

`branch` creates an approved `{category}/{topic}` branch. `edit` writes the scope lock outside the project and stops at `edit.implementation`. Only then does the Agent use normal file tools. Those file tools are not replaced by the CLI; enforcement occurs when current worktree paths and content are compared with the locked scope and evidence gates.

After implementation, `read-docs(after_edit)` audits the diff and binds its digest. The Agent then makes only documentation changes already declared in PlanDoc scope. `sync-docs` records and validates evidence; it does not write documentation.

If necessary work is outside scope, the Agent stops. It must follow the routed amendment path rather than editing first and asking forgiveness later.

## Verification

`verify` is the synchronous path for the issued check suite. `exam-plan` and `exam-submit` are the asynchronous path for long checks. Both paths bind the exact PlanDoc, scope, implementation fingerprint, commands and expected exits, and both produce the same canonical implementation manifest and verified digest on success.

Failures return to edit and invalidate evidence affected by the repair. A scope amendment enters `verify.amendment`; material expansion requires an explicit decision bound to the revised scope. Pure narrowing may preserve the original approval when the CLI says it is safe.

Small, Medium and Large are selected semantically by the Skill, while CLI is completeness authority. Passing Small checks never cancels a required Medium or Large check.

## Commit and CI

`commit` is a resumable three-stage command:

- `commit.prepare` checks current branch, scope, manifest and digest, then creates or recovers an exact commit identity;
- `commit.publish` pushes the exact object ID and creates or reuses only a PR with matching repository/base/head/OID identity;
- `commit.ci` observes structured checks and stays pending, returns to edit on failure, or advances to merge when required evidence is green.

The recovery record prevents a retry from creating another commit after a partial failure. A successful new verification supersedes an older commit-recovery record. Missing checks, skipped-only checks or neutral-only checks are not green when CI evidence is required.

## Merge and synchronization

`merge` persists an attempted receipt before its single remote merge mutation. A retry first reconciles the GitHub postcondition and, when necessary, uses **fresh-fetch ancestry** as a **read-only Git fallback**. That fallback can prove integration but cannot merge or push the base. It never repeats a mutation merely because the previous process returned an error.

After integration is confirmed, `merge.sync` updates only downstream branches proven by the recorded stack identity. Rebase results are computed in **detached staging**; local refs use **compare-and-swap** and remote updates use exact force-with-lease. Drift stops the workflow with recovery evidence rather than overwriting another actor's work.

Only a completed reconciliation and synchronization route to `done.completed`. `reset` then removes workflow-derived task state and returns to planning; it does not uninstall Skills or delete project files.

## Valid phase transitions

The kernel allows the following phase-level transitions, including same-phase retries:

```text
init    -> init | plan | done
plan    -> plan | approve | done
approve -> approve | branch | plan
branch  -> branch | edit | done
edit    -> edit | verify | commit | done
verify  -> verify | edit | commit | done
commit  -> commit | edit | merge | done
merge   -> merge | done
done    -> done
```

This table is descriptive, not callable authorization. The current envelope can expose a narrower route.

## Promotion exception

A base-branch to release-branch promotion, such as `dev` to `main`, is a release operation rather than an empty development task. Do not fabricate a PlanDoc with empty scope. The operator must explicitly authorize the promotion procedure, compare the exact source/target diff, create or reuse the promotion PR, wait for its real CI and merge it. This exception does not permit ordinary code changes to bypass the state machine.
