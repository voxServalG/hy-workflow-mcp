# Workflow Command Reference

This filename is retained for documentation compatibility. The public surface is a CLI command set, not MCP tools. All commands emit `hy-workflow.cli.v1` and must be invoked only when allowed by the current route.

## init command

Input: `{}`. Valid from initialization/planning readiness. It verifies the external deployment and configuration, collects local-only project cognition, initializes external workflow state and routes to `plan.before_plan`. It changes no project file or Git metadata and performs no external knowledge access.

Important result facts include `configAuthority`, `cognition`, external local artifact paths, `projectFilesChanged: []` and the next documentation route.

## status command

Input: `{}`. Read-only and available throughout the workflow. It returns the authoritative phase/stage/status, persisted workflow facts, allowed/blocked commands and exact next route. Use it whenever the previous envelope is missing, stale or unclear.

## read-docs command

Input fields: `stage`, optional/required stage-specific `task`, and optional `cursor`.

- `before_plan` builds the local fact baseline for a concrete task.
- `before_approve` audits whether current documentation still supports the decided PlanDoc.
- `after_edit` audits the current implementation diff and binds post-edit evidence.

Pagination follows only the returned cursor. The command reads the configured local documentation system and stores paths, hashes, graph, budget, pagination and drift metadata rather than conversational memory. It emits no stage purpose, audit checklist or other model-facing guidance; those procedures live in `hy-read-docs`. It does not contact Feishu/Lark or edit docs.

## plan command

Input: `{ "task": string, "plan": PlanDoc }`. Requires current `before_plan` evidence. It validates exact scope, repository-safe paths, dependency/boundary declarations, verification entries, risks and discussion, stores the PlanDoc and enters approval review.

The current `hy-plan` Skill presents the PlanDoc to the user. The public CLI does not embed a model prompt or approval script.

## approve command

Input fields: `approved`, required `decisionId`, optional `note`, optional `auditDecision`.

`approved` records one explicit approve/reject/revise decision only when `decisionId` matches the current PlanDoc. If `before_approve` evidence is missing, the CLI persists that bound decision and routes `read-docs`; it does not ask the user again for an unchanged PlanDoc. After material drift, `auditDecision` accepts only `continue` or `replan` according to the routed Skill judgment.

## branch command

Input: `{ "category": string, "topic": string }`. Category is one of `refactor`, `feat`, `chore`, `docs`, `ci`, `fix`, or `test`; topic is safe lowercase kebab-case. The CLI creates the branch from the configured base and records it. Direct branch creation must not be used to bypass the current route.

## edit command

Input: `{}`. It writes an identity-scoped external scope lock and stops at `edit.implementation`. It does not edit code. The Agent then uses normal file tools, touching only approved paths and preserving unrelated changes.

## sync-docs command

Input: `{}`. Requires current `after_edit` evidence and completion of any declared documentation edits. It validates that the implementation binding is still current, records documentation/DocsGraph evidence and routes verification. It never writes documentation itself.

## verify command

Input: `{}`. Runs the synchronous issued suite, including scope/boundary/platform and project checks. Success records the canonical implementation manifest and verified digest, clears stale commit recovery and routes commit. Failure returns named checks and an edit recovery.

Small/Medium/Large selection is made by `hy-verify`/`hy-plan` Skills from semantic conditions; CLI decides whether the issued evidence is complete.

## exam-plan command

Input: `{}`. Issues a time-bounded asynchronous manifest for long checks, bound to the exact PlanDoc, scope and implementation fingerprint. Each check contains an identity, exact command, expected result and nonce. Receiving a manifest is not verification success.

## exam-submit command

Input: `{ "examId": string, "results": [...] }`. Requires one complete result set whose IDs, commands, nonces, exits and optional output evidence match the issued exam. CLI rechecks current scope and boundaries. Success produces the same manifest/digest authority as synchronous verify and clears stale commit recovery.

## amend-plan command

Input fields: `approved`, required `decisionId`, optional `note`. It applies only the exact pending amendment identified by the current route. A stale identity fails without mutation. Material expansion requires an explicit bound decision; safe narrowing may preserve approval when CLI reports it. Changed scope invalidates affected documentation and verification evidence and returns through edit.

## commit command

Input: `{ "title": string, "body": string }`. Requires current verified implementation evidence. One command owns:

1. `commit.prepare`: exact scoped staging and commit identity;
2. `commit.publish`: exact-OID push and exact PR lookup/create;
3. `commit.ci`: structured check observation until green, failed or pending.

Retries consume the persisted recovery identity. They do not create another commit when the original commit already exists. CI failure returns to edit; pending/API uncertainty remains in commit; valid green evidence routes merge.

## merge command

Input: `{}`. Requires exact PR/verified-OID/CI identity. The CLI writes a receipt before its one merge mutation, reconciles an uncertain outcome, and then completes `merge.sync` using compare-and-swap and exact force-with-lease safeguards for proven downstream branches. It routes to done only after integration and synchronization are confirmed.

## reset command

Input: `{}`. Clears task-derived workflow state and returns to planning when allowed. It does not remove helper Skills, project external registration, repository files or Git metadata. Do not reset while a merge outcome is unresolved unless the structured recovery explicitly permits abandonment.

## Support surface

- `helper install|update|status|remove` owns Skill lifecycle and external registration.
- `lint --json` runs first-party offline doclint and codelint.
- `config` manages supported policy/config operations.
- `doctor` diagnoses external installation state.
- `lint-contract` checks this package's own CLI/Skill/package consistency.

See [CLI](./cli.md), [State Machine](./state-machine.md), [Output](./output.md), and [Skills](./skills.md).
