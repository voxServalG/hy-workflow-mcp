# Product Vision

This document turns GitHub issues #132 and #133 into a stable product direction for hy-workflow-mcp. The issues remain research and discussion records; this file is the project-facing vision that future roadmap PRs should reference.

## Positioning

hy-workflow-mcp is a human-approval-first, state-machine-driven, safety-default workflow MCP for LLM-assisted development. It does not try to replace developers or turn agents into unrestricted repository operators. It turns planning, scope control, approval, editing, verification, CI, merge, and downstream branch maintenance into a clear, auditable, recoverable protocol.

The public message should stay simple:

> hy-workflow makes coding agents plan first, get approval, lock scope, prove changes, and only then merge.

For new users, the value proposition is three points:

- Agents cannot silently edit outside the agreed scope.
- Every merge has evidence.
- When stuck, ask `hy_status`.

## Product Principles

### Fewer Concepts, Stronger Guarantees

The product should not become a large platform with many overlapping tools. The workflow is already strict enough; the product work is to reduce user and agent mental load. Prefer fewer entry points, fewer concepts, fewer configuration surfaces, and more deterministic recovery paths.

The ideal first-time experience is:

1. Install from README without reading all docs.
2. Run setup, review the client configuration plus the two small project files (`hy-workflow.json` and `.github/workflows/hy-workflow.yml`), then commit those files through a focused PR.
3. Restart the MCP client.
4. Ask the agent to call `hy_status`.
5. See the current phase, why it is there, what action is allowed next, what action is forbidden, and how to recover.

An upgrade is different from a first install. Updating the package must not make an existing user review or repair old repository injections. Old config files, generated workflow content, managed prompt blocks, local state directories, project client files, and compatibility lint files remain untouched and are ignored by hy-workflow. Existing external stage, approval, scope, and worktree state continue unchanged.

“Ignored by hy-workflow” has a clear boundary: a third party may still act on a tracked file. GitHub can continue to run an old committed Actions workflow until the team removes or disables it in a normal repository change. Optional cleanup must be separate from upgrade readiness.

### Project Parameters, Central Policy

Projects should own values such as source paths, base branch, profile choice, thresholds, scoped overrides, and time-bounded exceptions. The package should own rule meaning, validation, precedence, and immutable safety boundaries. Generated code and prompt injection are not configuration authorities.

Policy resolution must be explainable. A user should be able to ask for one rule and one file and receive the effective value plus the ordered sources that produced it. New quality rules should enter as advisory or warning where compatibility requires it; an upgrade must not unexpectedly block an old project. Scan integrity, project identity, evidence freshness, and scope/path boundaries remain non-disableable safety rules.

### `hy_status` Is The Dashboard

`hy_status` should be the single place users and agents go when they are unsure what to do. Avoid adding near-duplicate tools such as separate "where am I", "next step", or "doctor status" commands until `hy_status` has been made excellent.

Target dashboard fields:

- `where`: current phase in one sentence.
- `why`: why the workflow is stopped there.
- `next_action`: one recommended next action with tool and arguments.
- `danger`: whether the next action is destructive or touches network/files.
- `blocked`: who or what can unblock the workflow.
- `dirty_summary`: local changes that may affect the workflow.
- `progress`: where the run is in the full workflow.

### Plans Are Compiled, Not Performed

`hy_plan` should feel like a compiler for work intent. It must stay strict, but failure output should be precise enough that an agent can repair the PlanDoc without user debugging.

Target behavior:

- Gate errors include `field`, `bad_value`, and `example_fix`.
- Built-in examples cover docs-only, code-change, and fresh-install configuration tasks.
- Approval summaries state what changes, why, how it will be verified, and what risks remain.

### Verification Is Evidence

`hy_verify` should not merely run commands. It should produce evidence and recovery guidance. A failed check should tell the user whether the next step is editing, approving a scope amendment, waiting/retrying, fixing environment state, or stopping for a human decision.

Target check shape:

- `code`
- `layer`
- `name`
- `command`
- `passed`
- `classification`
- `expected`
- `observed`
- `fix`
- `can_auto_amend`

### Contracts Are The Source Of Public Truth

Tool behavior, docs, Skill instructions, server descriptions, and public tables should not drift. `COMMAND_CONTRACTS` plus contract lint should become the source of truth for public tool facts.

Target metadata:

- `phase`
- `readOnly`
- `destructive`
- `idempotent`
- `requiresApproval`
- `writesFiles`
- `touchesNetwork`
- `allowedArtifacts`
- `commonFailures`
- `recovery`
- `safeNext`
- `userFacingSummary`

## Safety Model

The default posture should be conservative and visible. Read-only or planning behavior should be easy to understand; file mutation, network activity, branch creation, PR creation, merge, and downstream rebase should be clearly marked.

The workflow must continue to reject:

- approving without explicit user approval;
- editing outside locked scope;
- committing local/runtime artifacts;
- skipping verification before commit;
- using direct git or GitHub operations to bypass workflow gates;
- treating runtime, client, or compatibility artifacts as committed project source.

Artifact boundaries stay central:

- fresh setup maintains exactly two team-owned repository surfaces: `hy-workflow.json` and a thin, exact-version `.github/workflows/hy-workflow.yml`;
- setup never injects or maintains `AGENTS.md`;
- an existing installation never reads, hashes, validates, migrates, or deletes legacy injected project files as an upgrade condition;
- unset and hy_init never delete or rewrite project files; deployment/state/cache and client configuration stay external.

## Documentation Model

Docs should be precise, not large. README should optimize the first five minutes. Deeper docs should be organized around user situations, not only tool names.

Important recipe areas:

- first run;
- docs-only change;
- code change;
- verify failure;
- CI red;
- fresh-install artifact review;
- seamless upgrade and optional legacy cleanup;
- promotion;
- reset and recovery.

Each recipe should say when to use it, when not to use it, what can go wrong, what command/tool to run, what output to expect, and how to recover.

## Roadmap Priorities

### P0: Make The Existing Workflow Obvious

- Rewrite the README first screen around the safety-belt value proposition, quickstart, client snippets, first prompt, and `hy_status`.
- Add compact `hy_status` dashboard fields without changing the state machine.
- Extend command catalog metadata for read-only, file/network mutation, user gates, safe next action, common failures, and recovery.
- Improve PlanDoc gate errors with `field`, `bad_value`, and `example_fix`.
- Stabilize verify check structure with expected, observed, fix, and recovery data.
- Add short recipes for first-run, seamless upgrade, optional cleanup, docs-only, code-change, verify-fail, and CI-red.

### P1: Make It Feel Like A Mature MCP Product

- Keep the `hy-workflow doctor --offline --json` recipe aligned with effective client scopes, direct bins/catalogs, external state, configuration authority, baseBranch, and docs readiness without inspecting inert legacy injections.
- Add LLM-readable docs entry points such as `llms.txt` or an equivalent generated index.
- Define profile/toolset language for audit, plan-only, local-dev, repo-ops, and promotion modes.
- Generate public tool tables from contract metadata and enforce drift through contract lint.
- Maintain release acceptance for real pinned repositories, isolated npm-tarball install, transaction faults, CI fail-closed, artifact boundaries and no remote writes; add focused evals for workflow recovery paths.

### P2: Increase Distribution And Trust

- Publish MCP registry/server metadata or an equivalent installable manifest.
- Add version policy, changelog discipline, migration notes, and deprecation paths.
- Consider an optional UI/status page only after structured status output is reliable.
- Add audit logging, telemetry/privacy switches, and stronger sensitive-output handling where appropriate.
- Evaluate hosted or bridge modes without weakening repository-minimal safety.

## Success Criteria

hy-workflow-mcp is moving toward this vision when:

- a new user can install it and call `hy_status` within five minutes;
- fresh setup never reports success until effective client configuration, the two new project artifacts, and external deployment agree;
- updating an existing installation never requires repository cleanup, repeated artifact approvals, or workflow-state reset;
- every effective policy value can be explained with ordered provenance;
- an agent can choose the correct next tool in any phase from `hy_status` and the last tool result;
- every destructive action is visible in runtime output, schema/tool metadata, and docs;
- every verify failure has one minimal recovery direction;
- public docs, Skill instructions, and tool schema no longer drift from implementation;
- local/runtime/client artifacts never enter the commit path;
- external explanations do not need the full internal workflow, only the safety-belt message.

## Non-Goals

- Do not loosen workflow gates to make the product feel simpler.
- Do not add many alias tools before improving the existing central tools.
- Do not build a large UI before the structured status and recovery contract is reliable.
- Do not turn PlanDoc into free-form prose.
- Do not treat research issues as direct implementation scope without splitting them into small PRs.
- Do not make marketing claims that cannot be traced to tool behavior, fields, checks, docs, or acceptance criteria.

## Relationship To Roadmap

This document defines the desired product state. `docs/pr-roadmap.md` splits that direction into reviewable PRs. If a roadmap item conflicts with this document, prefer the simpler, safer, more evidence-backed path and update the roadmap accordingly.
