# PR Roadmap

This document turns the current open issues into small, reviewable PRs. Each PR should have one owner, one branch, one verification path, and a scope small enough to review without rereading every issue.

The product direction behind this roadmap is captured in [Product Vision](./product-vision.md). This roadmap is the implementation split; the vision document is the long-term product target.

## Rules

- Trust and recovery work come before public polish.
- Research issues are references, not implementation scopes.
- Feedback bundles must be split into atomic PRs before closure.
- Every behavior change updates docs or tests when it changes agent-facing behavior.

## Milestone 0: Backlog Hygiene

| PR | Target issues | Scope | Acceptance | Verify |
| --- | --- | --- | --- | --- |
| PR-00 Label and split backlog | [#38](https://github.com/voxServalG/hy-workflow-mcp/issues/38), [#41](https://github.com/voxServalG/hy-workflow-mcp/issues/41), [#46](https://github.com/voxServalG/hy-workflow-mcp/issues/46), [#47](https://github.com/voxServalG/hy-workflow-mcp/issues/47), [#57](https://github.com/voxServalG/hy-workflow-mcp/issues/57), [#122](https://github.com/voxServalG/hy-workflow-mcp/issues/122), [#131](https://github.com/voxServalG/hy-workflow-mcp/issues/131), [#132](https://github.com/voxServalG/hy-workflow-mcp/issues/132), [#133](https://github.com/voxServalG/hy-workflow-mcp/issues/133) | Add labels such as `bug`, `ux`, `research`, `reference`, `public-ready`, `trust`, `backlog`; split mixed feedback issues; mark [#131](https://github.com/voxServalG/hy-workflow-mcp/issues/131), [#132](https://github.com/voxServalG/hy-workflow-mcp/issues/132), and [#46](https://github.com/voxServalG/hy-workflow-mcp/issues/46) as reference; audit [#122](https://github.com/voxServalG/hy-workflow-mcp/issues/122). | Every open issue has a clear role; [#38](https://github.com/voxServalG/hy-workflow-mcp/issues/38) and [#47](https://github.com/voxServalG/hy-workflow-mcp/issues/47) no longer act as active mixed scopes. | `gh issue list --repo voxServalG/hy-workflow-mcp --state open --limit 100` |

## Milestone 1: Trust Before Polish

| PR | Target issues | Scope | Acceptance | Verify |
| --- | --- | --- | --- | --- |
| PR-01 Fix state integrity and reset detection | [#110](https://github.com/voxServalG/hy-workflow-mcp/issues/110) | Audit `projectRoot`, git private path resolution, CWD drift, and state read/write paths; add state integrity marker with branch, plan hash, and last transition; detect impossible phase regression. | A valid edit-phase state cannot silently reset to plan; `hy_status` explains untrusted state and recovery; tests cover path and regression cases. | `npm run build`; `npm run test:unit`; `npm run test:e2e` |
| PR-02 Make setup-to-first-use trustworthy | [#121](https://github.com/voxServalG/hy-workflow-mcp/issues/121), reference [#133](https://github.com/voxServalG/hy-workflow-mcp/issues/133) | One Node TUI/CLI validates effective Codex/Claude/OpenCode scopes, tracked-file project evidence, docs/base readiness, confirmed native CI, two artifact diffs and transactional external state; doctor/unset recover without adding project artifacts. | Success means direct-bin handshakes, schema-3 tool/artifact evidence, clients, registry and ownership agree; cancel/dry-run write nothing; concurrent/fault recovery is fail closed. | `npm run verify`; `npm run test:acceptance`; `npm pack --dry-run --json` |
| PR-03 Add compact `hy_status` dashboard | [#133](https://github.com/voxServalG/hy-workflow-mcp/issues/133), related [#121](https://github.com/voxServalG/hy-workflow-mcp/issues/121) | Add stable fields `where`, `why`, `next_action`, `danger`, `blocked`, `dirty_summary`, `progress`; keep existing envelope fields. | Every phase has one recommended next action or clear blocker; users know whether to approve, edit, wait, rerun setup, or inspect CI in five seconds. | `npm run build`; `npm run test:unit`; `npm run test:e2e`; `npm run lint:contract` |
| PR-04 Add progress feedback for long `hy_verify` | [#123](https://github.com/voxServalG/hy-workflow-mcp/issues/123) | Record current layer, command, `startedAt`, last heartbeat, and elapsed time; let `hy_status` show in-progress or last-known verify state. | Long `npm test` or `npm run verify` does not look hung; interrupted turns recover through `hy_status`; final checks include durations. | `npm run build`; `npm run test:unit`; `npm run test:e2e` |
| PR-05 Harden GitHub API retry and fallback | [#37](https://github.com/voxServalG/hy-workflow-mcp/issues/37) | Add bounded retry/backoff for `hy_ci` and `hy_merge`; classify API failures; preserve request or command context; provide retry or `gh` recovery guidance. | Transient failures do not immediately break workflow; pending/API failures stop safely; merge recovery preserves PR and branch context. | `npm run build`; `npm run test:unit`; `npm run test:e2e` |

## Milestone 2: Recovery Friction

| PR | Target issues | Scope | Acceptance | Verify |
| --- | --- | --- | --- | --- |
| PR-06 Improve PlanDoc input recovery | [#41](https://github.com/voxServalG/hy-workflow-mcp/issues/41), [#38](https://github.com/voxServalG/hy-workflow-mcp/issues/38) | Return `field`, `bad_value`, and `example_fix`; improve JSON parse failure hints for `risks`, `discussion`, and command fields; add docs-only, code-change, and setup-artifact-sync examples. | Agents can repair malformed PlanDoc without user debugging; strict PlanDoc gates remain intact. | `npm run build`; `npm run test:unit`; `npm run test:e2e` |
| PR-07 Recover branch and PR context | [#38](https://github.com/voxServalG/hy-workflow-mcp/issues/38), [#47](https://github.com/voxServalG/hy-workflow-mcp/issues/47) | Let `hy_status` and `hy_commit` inspect current branch when workflow branch is missing; detect associated PR; improve `hy_branch` conflict output. | `No active branch` becomes actionable recovery; branch conflicts show local, remote, PR, and suggested action; no silent commit or push. | `npm run build`; `npm run test:unit`; `npm run test:e2e` |
| PR-08 Align verifier edge cases with CI semantics | [#47](https://github.com/voxServalG/hy-workflow-mcp/issues/47) | Treat codelint warning-only JSON consistently with CI; keep errors hard; test warning-only and error reports; confirm runtime metadata stays outside scope checks. | Warning-only lint does not block when CI would pass; error lint still blocks; OS user runtime metadata never enters PlanDoc scope. | `npm run build`; `npm run test:unit`; `npm run test:contract` |

## Milestone 3: Public-Ready Polish

| PR | Target issues | Scope | Acceptance | Verify |
| --- | --- | --- | --- | --- |
| PR-09 Refine agent operating rules | [#57](https://github.com/voxServalG/hy-workflow-mcp/issues/57), related [#121](https://github.com/voxServalG/hy-workflow-mcp/issues/121), [#133](https://github.com/voxServalG/hy-workflow-mcp/issues/133) | Clarify when to enter workflow, preflight checks, failure recovery by layer, safety rules for secrets, local artifacts, scope expansion, test deletion, and verification weakening. | Agent can distinguish discussion, read-only analysis, docs writing, and repo modification; recovery rules reduce reset/replan reflexes; prompt and tool descriptions agree. | `npm run build`; `npm run lint:contract`; `npm run test:e2e` |
| PR-10 Extend command catalog metadata and generated tool tables | [#133](https://github.com/voxServalG/hy-workflow-mcp/issues/133), related [#122](https://github.com/voxServalG/hy-workflow-mcp/issues/122), [#131](https://github.com/voxServalG/hy-workflow-mcp/issues/131), [#132](https://github.com/voxServalG/hy-workflow-mcp/issues/132) | Extend `COMMAND_CONTRACTS` with read-only, file/network mutation, user-gate, safe-next, common-failure, and recovery metadata; generate or lint public tool tables. | Tool changes without metadata fail contract lint; docs show phase, danger, next step, and recovery; existing tool names remain compatible. | `npm run build`; `npm run lint:contract`; `npm run test:contract` |
| PR-11 Rewrite README first screen and add recipes | [#121](https://github.com/voxServalG/hy-workflow-mcp/issues/121), [#133](https://github.com/voxServalG/hy-workflow-mcp/issues/133), references [#131](https://github.com/voxServalG/hy-workflow-mcp/issues/131), [#132](https://github.com/voxServalG/hy-workflow-mcp/issues/132) | Rewrite README around the safety-belt value proposition; add npm install, the single setup/unset TUI flow, two-file artifact boundary, mandatory doclint/codelint CI, and recovery recipes. | A new user can install, select clients, review the two team files, restart, and call `hy_status`; README makes external runtime data and required CI evidence explicit. | `npm run build`; `npm run lint:contract`; `npm test` |

## Milestone 4: Research Followups

| PR | Target issues | Scope | Acceptance |
| --- | --- | --- | --- |
| PR-12 Decide peercheck scope or close as reference | [#46](https://github.com/voxServalG/hy-workflow-mcp/issues/46) | Decide whether peercheck is near-term, future umbrella, or reference-only; if near-term, create one atomic implementation issue with output shape and non-goals. | No vague active issue requires a broad peercheck system; any follow-up has one clear output contract. |
| PR-13 Convert external MCP research into selected tasks | [#131](https://github.com/voxServalG/hy-workflow-mcp/issues/131), [#132](https://github.com/voxServalG/hy-workflow-mcp/issues/132) | Keep research issues as references; create implementation issues only for selected client matrix, first test prompt, generated docs or safety profiles beyond the shipped setup doctor/acceptance baseline. | Research no longer competes with bug and UX work; each selected idea has owner, acceptance criteria, and dependency on trust work. |

## Recommended Order

1. PR-00: backlog hygiene.
2. PR-01: state integrity.
3. PR-02: setup-to-first-use UX.
4. PR-03: `hy_status` dashboard.
5. PR-04: long-running verify feedback.
6. PR-05: GitHub API retry and fallback.
7. PR-06 through PR-08: recovery friction cleanup.
8. PR-09 through PR-11: public-ready product polish.
9. PR-12 and PR-13: research conversion or closure.

This order keeps the project honest: first make the workflow trustworthy, then make it easy to understand, then make it easy to promote.
