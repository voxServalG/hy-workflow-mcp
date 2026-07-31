# Stage Skills

The npm package ships 12 Skills under `skills/<name>/SKILL.md`. Helper installs the entire versioned bundle into selected user-level Agent Skill directories. Skills contain model-facing procedure and human communication; they do not contain workflow state. Each `SKILL.md` frontmatter contains only `name` and `description`; package version and hashes belong to the helper ownership manifest.

## Common control contract

`hy-status` owns the shared CLI authority and routing protocol. Each of the other 11 stage Skills links to `../hy-status/SKILL.md` as a prerequisite, then keeps only its command-specific procedure. This follows a shared-prerequisite bundle design without adding a thirteenth Skill or changing the state machine.

Every stage follows these rules:

1. Treat the CLI as sole authority for workflow state and evidence.
2. Never read, edit or reconstruct private config/state/cache files.
3. Load the shared `hy-status` contract, then call `hy-workflow status` unless the immediately previous envelope routes this Skill's exact command and is still current.
4. Obey `phase`, `stage`, `route.allowed`, `route.blocked`, `route.control` and exact `route.action.argv`.
5. Never infer, repeat or invent human approval.
6. Render human guidance from structured facts; do not present the raw JSON dump as an explanation.
7. Do not turn Skill observations into CLI evidence or silently weaken a required check.

## Bundle catalog

| Skill | Commands | Responsibility |
|---|---|---|
| `hy-init` | `init` | Establish local-only project cognition and report the CLI-authoritative starting route. |
| `hy-status` | `status` | Explain the current state, stop reason and exact next action. |
| `hy-read-docs` | `read-docs` | Collect bounded local facts at `before_plan`, `before_approve` and `after_edit`. |
| `hy-plan` | `plan` | Compose a scientific PlanDoc and choose semantic test scales. |
| `hy-approve` | `approve` | Submit one explicit human decision and handle the evidence audit continuation. |
| `hy-branch` | `branch` | Create only the branch authorized by the current route. |
| `hy-edit` | `edit` | Lock scope, perform normal file edits and return through post-edit evidence. |
| `hy-sync-docs` | `sync-docs` | Confirm declared documentation edits and record current sync evidence. |
| `hy-verify` | `verify`, `exam-plan`, `exam-submit`, `amend-plan` | Run short or long verification and handle scoped amendments. |
| `hy-commit` | `commit` | Carry prepare, publish and `commit.ci` to a terminal route. |
| `hy-merge` | `merge` | Reconcile one merge mutation and complete `merge.sync`. |
| `hy-reset` | `reset` | Clear completed/abandoned task-derived state only when the CLI permits it. |


## Package self-inspection

The CLI serves the first-party Skill content shipped in its own npm package:

```bash
hy-workflow skills list --json
hy-workflow skills read hy-status
hy-workflow skills read hy-verify --json
```

`skills list` returns the package name/version, complete bundle hash, canonical workflow order, trigger descriptions and per-Skill hashes. `skills read` emits the exact packaged UTF-8 file by default or a versioned JSON envelope with `--json`. An optional relative file path supports progressively disclosed references; absolute paths, backslashes, traversal, directories and symbolic links fail closed.

Helper state remains the installation authority. `helper status` compares the owned manifest's package version and bundle hash with the running CLI package, in addition to validating canonical and projected content. A same-name directory without matching ownership is never treated as installed state.
There is intentionally no `hy-ci` Skill and no `hy-chain` Skill. Those are internal stages of `hy-commit` and `hy-merge` respectively.

## hy-init Skill

Initialization uses only local read-only evidence: progressive documentation entry points, manifests and lockfiles, source layout, compiler/linter/test configuration, local CI files, worktree status, recent commits and merge commits. It must not access Feishu, Lark, a team knowledge base, remote pull-request APIs or web search. Missing local evidence is reported as unavailable.

CLI decides whether project identity, deployment, config and state are valid. The Skill explains ecosystems and candidate test platforms without claiming that a candidate command has passed.

## Scientific planning and test scales

`hy-plan` starts from a current `before_plan` read. A complete plan describes the problem and expected state, exact changed/new/deleted paths, dependency direction, unaffected boundaries, environment setup, concrete check commands and expected exits, risks as scenario-impact-mitigation, and at least one rejected alternative.

The Skill selects scales by fixed semantics:

- Small is always required for changed deterministic units and static contracts. It is sufficient alone only within one module and without process, filesystem, database, network, schema, public API, packaging or migration boundaries.
- Medium is required for modules, processes, local persistence, serialization, schema, public API, CLI behavior, configuration, concurrency or recovery state.
- Large is required for installation, upgrade, packaging, release, CI, cross-platform behavior, external services, security boundaries, irreversible compatibility or a historical incident that needs an end-to-end fixture.

The PlanDoc and CLI-issued check manifest are minimums. A Skill cannot remove a check because a smaller scale already passed. Runtime and file-count heuristics may inform cost, but do not define scale.

## Editing

`hy-edit` does not ask the CLI to write code. It first locks the approved scope, then the Agent uses its ordinary file tools. The Skill preserves unrelated user changes and stops before any out-of-scope edit. After implementation it follows `read-docs(after_edit)`, makes only declared documentation changes, and calls `sync-docs` to record evidence.

Historical incident tests and project invariants should be added when relevant. They are repository artifacts and remain reviewable through Git; the Skill does not hide them in private state.

## Verification

`hy-verify` chooses synchronous `verify` for short issued suites. For long suites it obtains an `exam-plan`, runs every exact command with its binding and nonce, captures bounded results, and submits one complete result set. Results cannot be manufactured, partially reused or applied after the implementation fingerprint changes.

Failures return to the named edit layer. A material scope expansion follows `amend-plan` and requires an explicit decision when the CLI exposes an approval user action.

## Commit and merge

`hy-commit` and `hy-merge` never replace an uncertain CLI result with direct Git or GitHub commands. Commit retry consumes the existing exact-OID recovery record. Merge retry consumes the attempted/confirmed receipt and reconciles remote state before any further mutation. The Skill stops on identity drift, missing permissions, pending checks or unresolved synchronization and explains the structured facts to the user.

## Presentation boundary

Prompt prose that previously lived beside TypeScript transport handlers belongs in these Skills. CLI output intentionally removes `display`, `summary`, `hint`, prompt/instruction and shell-command fields from its public envelope. Skills are free to write clear human prose, but approval, phase, checks and recovery remain facts only when present in the CLI envelope.
