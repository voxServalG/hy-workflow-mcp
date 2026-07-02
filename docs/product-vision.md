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
2. Restart the MCP client.
3. Ask the agent to call `hy_status`.
4. See the current phase, why it is there, what action is allowed next, what action is forbidden, and how to recover.

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
- Built-in examples cover docs-only, code-change, and setup-artifact-sync tasks.
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
- treating setup/client compatibility artifacts as committed project source.

Artifact boundaries stay central:

- tracked project artifacts: `.github/`, `AGENTS.md`, `.gitignore`, `hy-workflow.json`;
- local/runtime/client artifacts: `.hy/`, `.opencode/`, `.codex/`, `.mcp.json`, `codelint.json`, `doclint.json`, `docs-gardener.json`.

## Documentation Model

Docs should be precise, not large. README should optimize the first five minutes. Deeper docs should be organized around user situations, not only tool names.

Important recipe areas:

- first run;
- docs-only change;
- code change;
- verify failure;
- CI red;
- setup artifact sync;
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
- Add short recipes for first-run, docs-only, code-change, verify-fail, CI-red, and setup-artifact-sync.

### P1: Make It Feel Like A Mature MCP Product

- Add a doctor or Inspector recipe for MCP connection, client config, git remote, GitHub auth, docsDir, baseBranch, artifact ignore, and tool catalog consistency.
- Add LLM-readable docs entry points such as `llms.txt` or an equivalent generated index.
- Define profile/toolset language for audit, plan-only, local-dev, repo-ops, and promotion modes.
- Generate public tool tables from contract metadata and enforce drift through contract lint.
- Add manual tests or evals for happy path, verify-fail recovery, CI red stop, and promotion path.

### P2: Increase Distribution And Trust

- Publish MCP registry/server metadata or an equivalent installable manifest.
- Add version policy, changelog discipline, migration notes, and deprecation paths.
- Consider an optional UI/status page only after structured status output is reliable.
- Add audit logging, telemetry/privacy switches, and stronger sensitive-output handling where appropriate.
- Evaluate hosted or bridge modes without weakening local-first safety.

## Success Criteria

hy-workflow-mcp is moving toward this vision when:

- a new user can install it and call `hy_status` within five minutes;
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
