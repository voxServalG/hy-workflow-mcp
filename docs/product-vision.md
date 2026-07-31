# Product Vision

hy-workflow is a CLI plus stage-Skill system for evidence-driven agent development. Its purpose is not to make an agent sound disciplined. Its purpose is to preserve one inspectable workflow state, bind each consequential action to current evidence, and make the safe next action unambiguous across different agents.

The public promise is:

> The Skill decides how to understand and explain the work. The CLI decides what state is true, what evidence is sufficient, and what action is allowed next.

## The product split

The CLI owns mechanisms that must remain deterministic:

- installation, update, ownership and status checks;
- canonical project identity and external configuration;
- phases, stages, scope locks and approval bindings;
- documentation, implementation and verification evidence;
- first-party offline doclint and codelint;
- exact Git and GitHub mutations, recovery receipts and fail-closed routing;
- one versioned machine-readable output envelope.

The 12 bundled Skills own work that requires contextual judgment:

- explaining the current state to a person;
- reading the repository and forming project cognition;
- composing a scientific PlanDoc from local facts;
- deciding whether Small, Medium and Large tests are required;
- implementing within the approved scope with normal agent file tools;
- turning structured failures into useful, stage-specific recovery guidance.

This split is intentionally asymmetric. A Skill may add interpretation, but it may not override a CLI phase, invent approval, omit a CLI-required check, reconstruct private state or guess a command. The exact `route.action.argv` returned by the CLI is the executable authority.

## User experience

The expected first-use flow is:

1. Install `@voxstudio/hy-workflow` globally.
2. Run `hy-workflow helper install` in a Git project, with explicit Agent targets when detection is insufficient.
3. Restart the selected Agent so it discovers the 12 Skills.
4. Ask for a real development change.
5. Let `hy-init` establish a local project cognition baseline, then follow the routed stages.
6. Review one complete PlanDoc and give one explicit decision.
7. Intervene again only when the CLI reports a material amendment, unsafe drift, an external permission problem or an uncertain remote outcome.

The helper must make this feel uneventful. A fresh install writes no project file and no Git metadata. An upgrade in the same checkout preserves the exact existing deployment, registry, configuration, workflow state, scope and working tree. A proven genuine move changes only deployment and registry identity fields in one transaction. It may retire a legacy `hy-workflow` MCP registration only when the old ownership record and current bytes prove that the registration is ours.

## Product principles

### One authority, many Agent presentations

Codex, Claude Code and OpenCode may render different prose, but they must consume the same CLI facts and move through the same state machine. Agent-specific prompt injection is replaced by versioned Skills. State is never stored in a Skill or inferred from conversation history.

### Status before speculation

When an Agent lacks a current route, it calls `hy-workflow status`. The status envelope answers where the workflow is, which actions are allowed or blocked, whether execution must stop, and the exact next argv when one exists. Adding another dashboard command is preferable only when the status contract cannot represent the fact.

### Plans are compiled intent

A PlanDoc is not a conversational checklist. It binds a concrete problem to exact paths, dependency direction, unaffected boundaries, setup requirements, verification entry points, risks and rejected alternatives. The CLI validates its shape and safety; the `hy-plan` Skill is responsible for scientific completeness and a clear approval presentation.

### Approval is singular and bound

One explicit human decision applies to one exact PlanDoc. A subsequent `before_approve` documentation audit checks whether the facts still support that decision. It does not create a second approval gate. Material change returns to planning or requests an amendment decision; silence and general intent never count as approval.

### Verification is evidence, not a ritual

Every change receives Small checks. Medium and Large checks are selected by fixed semantic conditions, not by arbitrary labels or elapsed time. The Skill selects the required scales from project and change facts. The CLI checks the issued manifest, executes or validates results, records an implementation digest and refuses stale evidence.

Historical incidents and stable project invariants are first-class test inputs. A release-critical migration is incomplete if only the ecosystem's happy-path test suite passes while the previous failure mode is absent.

### Local quality first; CI remains team policy

doclint and codelint are first-party, offline CLI features. Teams should run them locally and may invoke the same command from their existing CI. The helper does not inject a GitHub Actions workflow and does not decide a repository's runners, native toolchains or branch-protection rules. Dependency-graph lint remains out of scope until a useful cross-ecosystem contract exists.

### Recovery is a protocol

Push, pull-request creation, CI observation, merge and downstream synchronization can fail after a remote mutation. The CLI persists exact repository, branch and object identities before mutation, then reconciles postconditions on retry. Unknown outcomes remain unknown; no Skill may turn them into success or issue a second mutation directly.

### Installation must be reversible and ownership-aware

Names are not ownership. The helper records the exact Skill bundle hash, canonical copy, target set, projection mode and per-resource hashes. Update and remove compare current state with that manifest, preserve deliberate user deletion by default and fail on collisions or unowned drift. Partial operations expose completed layers and an exact recovery argv.

## Project cognition and invariants

`init` is the boundary between “this package is installed” and “this Agent understands enough local facts to begin planning.” It is local-only and read-only. It inspects manifests, lockfiles, source layout, compiler and test configuration, local documentation, worktree status, recent commits and local merge evidence. It never contacts Feishu, Lark, a remote knowledge base or the network.

Project invariants should remain reviewable in the repository's normal Git artifacts: documentation, tests, fixtures, schemas, manifests and historical incident regressions. The CLI stores only the operational projection needed to enforce the current workflow in OS user directories. This avoids turning a private SQLite or opaque state database into the team's source of truth while still giving one local process strict, atomic state.

## Compatibility direction

The migration from MCP to CLI plus Skills is a transport and presentation change, not permission to silently redesign the kernel. The existing phase order, PlanDoc gates, scope verification, documentation evidence, verification manifests and commit/merge recovery remain. Human prompt prose moves to Skills; the public CLI emits facts and routes, not hidden model instructions.

Compatibility aliases are narrow:

- `hy-workflow setup` means `hy-workflow helper install`;
- `hy-workflow unset` means `hy-workflow helper remove`;
- existing external project state is preserved rather than copied into a new identity;
- equivalent GitHub remote spellings resolve to one canonical project identity;
- legacy MCP retirement is ownership-checked and one-way; remove does not restore it.

Compatibility does not mean continuing an MCP server entrypoint or creating new repository injections. The active binary is `dist/main.js` and fresh helper operations always report `projectFilesChanged: []`.

## Non-goals

hy-workflow does not:

- replace the Agent's editor, shell or repository-reading tools;
- host an MCP server;
- inject `AGENTS.md`, `.mcp.json`, project Agent directories or GitHub Actions;
- fetch external project knowledge during `init`;
- infer human approval;
- provide a universal dependency-architecture linter;
- install every project's language toolchain or replace native CI;
- silently clean old tracked artifacts from a repository;
- guarantee safety when a user or unrelated tool deliberately bypasses the CLI.

## Measures of success

The product is successful when a fresh project can be installed without a repository diff, an existing MCP-based project can update without losing phase or scope, three supported Agents receive the same versioned Skills, a person can understand every stop from the current structured envelope, and release acceptance proves the installed tarball rather than only the source checkout.
