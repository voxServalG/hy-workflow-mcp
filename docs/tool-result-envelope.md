# Kernel Result and Public CLI Projection

The workflow kernel predates the public CLI adapter and still uses a rich internal result envelope. That internal contract supports the unchanged state machine and compatibility tests. It is not the Agent-facing transport. `src/cli/workflow.ts` projects each handler result into the compact `hy-workflow.cli.v1` contract documented in [Output](./output.md).

## Why both shapes exist

The migration changes transport and presentation without rewriting the high-risk workflow kernel at the same time. Existing handlers can continue to calculate state, approval, checks and recovery using their typed result shape. The adapter then:

- retains evidence and domain facts;
- maps internal compatibility actions to public CLI command names;
- emits an exact argv array;
- removes model-facing prose and shell instruction strings;
- serializes exactly one versioned JSON document.

Skills consume only the projected CLI envelope. They must not import handlers or reconstruct the internal envelope from private state.

## Internal kernel fields

The compatibility catalogs in `src/output/contract.ts` describe internal fields such as:

- control: `ok`, `phase`, `next`, `stage`, `status`, `nextAction`, `control`, `userAction`;
- facts: `data`, `checks`, `findings` and command-specific values;
- presentation compatibility: `display`, `summary`, `hint`;
- stop compatibility: `requires_user`, `stop_here`, `allowedTools`, `blockedTools`;
- recovery compatibility: `strategy`, `tool`, `arguments`, `command`, `instruction`, `byLayer`;
- pagination: `has_more`, `page_token`, `next_page_token`;
- metadata: `command`, `cwd`, `identity`, `format`, `version`, `request_id`, `trace_id`, `duration_ms`;
- notices and structured errors.

These names are implementation compatibility, not a promise that public CLI output exposes every field.

## Projection rules

| Kernel value | `hy-workflow.cli.v1` value |
|---|---|
| `phase`, `stage`, `status`, `ok` | top-level position fields |
| domain-specific non-control fields | top-level fact fields |
| `next` | `route.nextPhase` |
| `nextAction.tool` | mapped `route.action.command`, or external `target` |
| complete `nextAction.arguments` | signed `route.action.input` plus deterministic `route.action.argv` |
| known handoff with missing input | `route.action.command`, signed partial `input`, null `argv`, and typed `inputRequired` |
| bounded command selection | null action plus explicit `route.choices`; never inferred from `allowed` |
| `allowedTools`, `blockedTools` | mapped `route.allowed`, `route.blocked` |
| `control` | `route.control` |
| `userAction` | `route.userAction` without `prompt` or `instruction` |
| `recovery` | `route.recovery` without shell command or instruction prose, with mapped command/argv when safe |
| structured error | top-level `error` without `hint` |
| `display`, `summary`, top-level `hint` | omitted; the current Skill owns human presentation |

The adapter canonicalizes JSON input when constructing route argv. An Agent executes the returned array directly and does not concatenate it into a shell command.

## Skill consumption order

1. Confirm `schema` and `version`.
2. Read `phase`, `stage`, `status` and `ok`.
3. Use structured fact/error fields to explain what happened.
4. Obey `route.control.stop` and `route.userAction`.
5. Ask for approval only when the structured user action is an approval for the current decision identity.
6. When `route.action.argv` is non-null, execute that array unchanged after the structured stop condition is satisfied.
7. When argv is null and `route.action.command` is non-null, hand off only to that command's Skill. It may fill exactly the declared `inputRequired` paths from their named sources, preserve signed partial input, and add no other fields.
8. When both argv and command are null, process only explicit `route.choices`, an external target, recovery, or a terminal result. The Skill must not choose from `allowed` or infer a command from phase/stage.
9. Use `route.recovery.strategy` and its exact argv after the named repair, wait, or external condition.
10. Call `status` once when a route is absent or stale; a second ambiguous null route is a CLI contract failure, not a reason to form a status loop.

Natural-language messages are never parsed to infer phase, permission or approval.

## Approval projection

The plan command stores a complete PlanDoc and returns facts that the `hy-plan` Skill turns into the approval presentation. The first explicit decision is submitted through `approve` with the exact `decisionId` fixed by the route. If the current documentation audit is missing, the kernel persists that bound decision and routes `read-docs(before_approve)`. No material drift reuses the same identity; material drift routes an Agent `continue`/`replan` judgment. A stale identity is rejected without mutation. The CLI does not emit or replay a hidden approval prompt.

One approval remains bound while intent, scope, risks and evidence bindings remain materially unchanged. A new PlanDoc, real scope/risk expansion or new delete target requires a new decision.

## Verification projection

Verify failure preserves structured `checks`, failed-check facts and layer recovery while routing to edit. Verify success exposes the current implementation manifest/digest and routes to commit. Long suites use `exam-plan` and `exam-submit`; the public action remains an argv array rather than an instruction string.

A successful new synchronous or exam verification supersedes stale commit recovery. Failure does not.

## Commit and merge projection

Commit owns `commit.prepare`, `commit.publish` and `commit.ci`. Pending CI is a wait/retry state, not approval. Missing/no-effective checks produce `CI_CHECKS_REQUIRED` when CI evidence is active. The projected route never suggests merge until the kernel has valid green evidence.

Merge success exposes `data.outcome` as `merged_now`, `already_merged` or `already_integrated`, along with evidence/executor and synchronization facts. Recovery keeps immutable repository/PR/base/head/verified-OID identity separate from mutable lifecycle and receipt stage.

An attempted receipt precedes the sole merge mutation. Reconciliation may use fresh-fetch ancestry as a read-only Git fallback. Confirmed downstream sync uses detached staging, compare-and-swap and exact force-with-lease. `PR_MERGE_OUTCOME_UNCONFIRMED`, `POST_MERGE_SYNC_INCOMPLETE` and `MERGE_LOCK_BUSY` remain structured stops; Skills cannot replace them with direct mutations.

## Structured errors

The kernel error contract contains `type`, `subtype`, `code`, `message`, `hint`, `detail`, `cause`, `retryable`, `risk`, `permission_violations`, `missing_scopes`, `console_url`, `request_id`, and `trace_id`. The CLI omits `hint` because recovery prose belongs to Skills, while preserving the remaining structured context when present.

Parse/dispatch failures also use the public versioned envelope. They route to status rather than emitting a bare object/string error.

## Compatibility boundary

Legacy handler fields and internal action names may remain until the kernel is deliberately refactored. They are allowed only behind the CLI adapter and in focused compatibility code. Public docs, Skills, package entrypoints and acceptance scenarios use CLI command names and `hy-workflow.cli.v1`.

This boundary allows prompt text to move out of TypeScript transport code without changing verification, commit or merge semantics during the same release.
