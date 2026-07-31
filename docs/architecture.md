# Architecture

hy-workflow has two public runtime layers and one existing workflow kernel. The public layers are the `hy-workflow` CLI and a bundle of 12 stage Skills. The kernel keeps the state machine, PlanDoc validation, evidence, verification and Git/GitHub recovery logic. There is no active MCP server entrypoint.

```text
Person
  |
  v
Agent + current hy-* Skill
  |  human judgment, repository reading, explanation, normal file edits
  |  exact argv from the previous CLI envelope
  v
hy-workflow CLI (dist/main.js)
  |  input validation, state transition, evidence, lint, Git/GitHub effects
  v
existing workflow kernel
  |
  +-- OS user config/state/cache/data
  +-- git and authenticated gh executors
  +-- project-owned compilers, tests and CI checks
```

## Authority boundaries

The CLI is the sole authority for:

- project identity and configuration selection;
- phase, stage, status and allowed or blocked commands;
- PlanDoc, approval, scope and documentation-evidence bindings;
- implementation manifests and verified implementation digests;
- local doclint/codelint findings;
- exact branch, commit, pull-request, CI and merge identities;
- recovery receipts and the next executable argv.

Skills are the sole home for model-facing procedure and presentation. They can inspect normal project files, choose an explanation, assemble a PlanDoc, select test scales and perform approved edits. They cannot read or mutate private runtime files, synthesize approval, weaken CLI checks or execute a blocked command.

The user owns intent, the one PlanDoc decision, repository policy and any authorization outside the current workflow. The project continues to own its documentation, invariant tests, language configuration, native CI and branch protection.

## Public command path

`src/main.ts` builds to `dist/main.js` and is both the npm `main` and `bin["hy-workflow"]`. It routes four classes of commands:

1. `helper install|update|status|remove` for Skill lifecycle, project registration and legacy MCP retirement;
2. 15 workflow commands from `init` through `reset`;
3. `lint`, `config` and `doctor` support commands;
4. `lint-contract` for this package's own public-contract checks.

Workflow commands accept exactly one JSON object through `--input`, `--input-file` or the empty default. The adapter validates command-specific fields, invokes the existing handler, removes prompt and shell-instruction fields, and emits one compact `hy-workflow.cli.v1` document. The route maps internal compatibility action names to public CLI command names and provides argv as an array, so a Skill never has to quote or compose a shell command.

## Helper installation data flow

```text
packaged skills/*
  -> validate complete 12-Skill bundle and compute bundle hash
  -> stage canonical user-level copy (SSOT)
  -> project to exact Agent targets by symlink or copy
  -> verify per-resource hashes
  -> atomically replace ownership manifest
  -> register this Git project in external config/state
  -> retire only exactly owned legacy hy-workflow MCP entries
```

The helper returns three independent layers: `skills`, `project` and `mcp`. A failure after one layer succeeds returns `status: "partial"`, lists completed layers and supplies the exact helper argv to resume. It never hides a partial migration behind a successful exit status.

### Skill single source of truth and projections

The package's 12 Skill directories form the release bundle. Installation copies a validated snapshot into the hy-workflow user data root, then creates target projections for Codex, Claude Code and OpenCode. `auto` prefers symlinks and can fall back to staged copies where symlinks are unavailable; callers may pin `symlink` or `copy` on first install.

The ownership manifest records package name/version, bundle hash, canonical root, exact Agent target set, resolved target directories, projection preference, canonical hashes, projection hashes and intentional-deletion state. Target set and projection preference are immutable during an install lifecycle. This prevents an update from silently broadening access to a newly detected Agent.

Every mutation uses path guards, a whole-helper operation lock, the narrower projection lock, staged resources, hash checks and rollback. Preflight fingerprints are recorded in the projection transaction; swap/remove compares them again, verifies any atomically staged backup and publishes new destinations with no-replace semantics. A same-name directory is not sufficient proof of ownership. Update refuses unmanaged collisions; remove deletes only resources whose current identity is still explained by the manifest. Missing projections are treated as deliberate user deletion and remain missing during ordinary update; `update --repair` is the explicit request to restore them.

### External-only project registration

The helper resolves a real Git project root and rejects any helper-owned path inside the worktree or Git common directory. A fresh registration writes a complete project config, deployment and registry record only to OS user roots. `projectFilesChanged` is always empty. Workflow state and scope are created later by the workflow kernel, also outside the project and `.git`.

If a deployment already exists in the same checkout, helper requires its registry record to match identity, mode, clients and `updatedAt`, then returns `preserved` without rewriting deployment, registry, config, workflow state or scope. An orphan deployment or registry record fails closed. If that checkout genuinely moved, status stays read-only and routes to install; install may transactionally reconcile only the deployment and registry identity after proving an exact, unique alias. In both cases config, workflow state, scope and all unrelated state remain unchanged, so an MCP-era workflow keeps its current phase, approval and evidence.

### Legacy MCP retirement

After Skills and project registration succeed, helper immediately rechecks that the installed Skill status is healthy and byte-equivalent to the manifest produced by this operation, then examines the existing ownership record for selected clients. It removes only the `hy-workflow` MCP entry that the old installer provably owns and whose effective state matches the recorded snapshot. It preserves `docs-gardener`, every unrelated MCP entry, project-local overrides and unowned same-name content. The removal is transactional and reports recovery-required clients instead of guessing.

Retirement is one-way. `helper remove` removes only owned Skill resources; it preserves project state and the current MCP configuration and does not recreate the legacy server.

## Project identity and state

Runtime state is partitioned by a canonical Git identity, not merely the current directory string. Equivalent GitHub SSH and HTTPS locators, host casing, default ports, trailing slashes and `.git` suffixes normalize to one repository locator. An existing legacy raw-locator identity may be aliased read-only when it is the single unambiguous active deployment. If canonical and legacy identities are both active, or several legacy candidates match, runtime returns an identity conflict instead of merging state.

External roots follow the operating system:

- Linux uses XDG config, state, cache and data roots;
- macOS uses the user's Library application-support layout;
- Windows uses LocalAppData-compatible roots;
- Agent Skill target roots honor the supported Agent environment overrides.

The exact paths are returned by helper and status operations. They are implementation state, not team artifacts; Skills must never open them directly.

## `init` cognition boundary

`init` verifies the external deployment and selected configuration, then collects a `hy-workflow.project-cognition.v1` snapshot from local read-only evidence. The snapshot includes:

- ecosystems, source extensions/directories and candidate build/test commands;
- local documentation entry points;
- branch, HEAD, upstream, dirty files and origin;
- up to eight recent commits and eight local merge commits;
- the fixed Small/Medium/Large test contracts.

It does not fetch, browse or call a team service. “Pull-request review” is a Skill-side interpretation of already local merge evidence; unavailable evidence stays unavailable. On success, only external workflow state changes and routing advances to `plan.before_plan`.

## Workflow data flow

```text
status
  -> read-docs(before_plan)
  -> plan -> one human decision
  -> approve -> read-docs(before_approve) -> approve continuation/replan
  -> branch
  -> edit scope lock -> normal file editing
  -> read-docs(after_edit) -> declared documentation editing -> sync-docs
  -> verify | exam-plan + exam-submit | amend-plan
  -> commit.prepare -> commit.publish -> commit.ci
  -> merge.reconcile -> merge.sync
  -> done -> reset
```

The kernel persists digests instead of trusting conversational memory. Documentation reads bind paths and hashes; `after_edit` and `sync-docs` bind the implementation snapshot; verification records a canonical implementation manifest and digest; commit recovery binds the exact Git object, repository, base and branch; merge recovery binds the immutable pull-request identity before mutation.

Successful synchronous verify and successful exam submission both supersede stale commit-recovery records. Failed or incomplete verification cannot erase recovery evidence.

## Test-scale decision model

The split of authority is deliberate:

- the Skill decides which semantic scales the change requires;
- the PlanDoc names concrete commands and expected results;
- the CLI validates required fields, executes short checks or issues a bound exam, checks scope/boundary invariants and decides whether evidence is complete.

Small is always required. Medium is required for module, process, storage, schema, CLI, public API, configuration, concurrency or recovery boundaries. Large is required for installation, upgrade, packaging, release, CI, cross-platform, external-service, security, irreversible-compatibility or historical-incident behavior. The categories describe system boundaries, not duration.

## Lint and CI boundary

doclint and codelint are offline first-party CLI checks. They share the package's policy model and never create legacy compatibility JSON. Dependency lint is intentionally absent. A consuming team may call `hy-workflow lint --json` in existing CI, but helper never creates or edits a workflow. Native compiler, test and deployment jobs remain repository-owned.

The workflow kernel can observe required pull-request checks during `commit.ci`, but observation does not imply installation. Repositories decide which checks exist and which are required. Missing, neutral-only or skipped-only evidence remains fail closed when the active policy requires CI evidence.

## Reference implementations and adopted choices

The helper design was checked against three pinned implementations. These are design references, not runtime dependencies.

### Lark CLI skills synchronization

- [`internal/skillscheck/sync.go` at `003d0f42...`](https://github.com/larksuite/cli/blob/003d0f42f84d3799c62f2a666fb0ddf4084283c7/internal/skillscheck/sync.go)
- [`internal/skillscheck/state.go` at `003d0f42...`](https://github.com/larksuite/cli/blob/003d0f42f84d3799c62f2a666fb0ddf4084283c7/internal/skillscheck/state.go)
- [`internal/skillscheck/check.go` at `003d0f42...`](https://github.com/larksuite/cli/blob/003d0f42f84d3799c62f2a666fb0ddf4084283c7/internal/skillscheck/check.go)
- [`content_embed.go` at `003d0f42...`](https://github.com/larksuite/cli/blob/003d0f42f84d3799c62f2a666fb0ddf4084283c7/content_embed.go)
- [`internal/skillcontent/reader.go` at `003d0f42...`](https://github.com/larksuite/cli/blob/003d0f42f84d3799c62f2a666fb0ddf4084283c7/internal/skillcontent/reader.go)
- [`cmd/skill/skill.go` at `003d0f42...`](https://github.com/larksuite/cli/blob/003d0f42f84d3799c62f2a666fb0ddf4084283c7/cmd/skill/skill.go)
- [`skills/lark-event/SKILL.md` at `003d0f42...`](https://github.com/larksuite/cli/blob/003d0f42f84d3799c62f2a666fb0ddf4084283c7/skills/lark-event/SKILL.md)
- [`skills/lark-shared/SKILL.md` at `003d0f42...`](https://github.com/larksuite/cli/blob/003d0f42f84d3799c62f2a666fb0ddf4084283c7/skills/lark-shared/SKILL.md)

We adopted a versioned/hashable installed-state record, explicit version-drift detection, package-served `skills list/read` content, and a shared prerequisite Skill pattern. The package is the immutable content source; helper state records which snapshot and projections are owned.

hy-workflow extends that model with exact multi-Agent target ownership, per-resource hashes, transactional projections, explicit repair, deliberate-deletion preservation and project-registration layers because an interrupted MCP-to-CLI migration must not leave a false success state. It keeps exactly 12 workflow-stage names, so `hy-status` carries the shared protocol instead of adding another public Skill. Frontmatter stays at the portable `name` and `description` subset; version is recorded in the ownership manifest rather than duplicated in Markdown.

### cc-switch Skill service

- [`src-tauri/src/services/skill.rs` at `a354f08a...`](https://github.com/farion1231/cc-switch/blob/a354f08a3d513e5f2f0b19b3d4d426ce63b689b5/src-tauri/src/services/skill.rs)

We adopted the useful separation between a canonical Skill source and per-client symlink/copy projections, plus hash-backed ownership and collision checks. hy-workflow keeps its manifest in OS user state rather than a project database and makes target-set immutability explicit, because helper's first duty is a no-diff, byte-preserving migration.

### Vercel Labs Skills installer

- [`src/agents.ts` at `1164afa5...`](https://github.com/vercel-labs/skills/blob/1164afa5f0e21ebd01e6fc11249759353f494ad1/src/agents.ts)
- [`src/installer.ts` at `1164afa5...`](https://github.com/vercel-labs/skills/blob/1164afa5f0e21ebd01e6fc11249759353f494ad1/src/installer.ts)
- [`src/skill-lock.ts` at `1164afa5...`](https://github.com/vercel-labs/skills/blob/1164afa5f0e21ebd01e6fc11249759353f494ad1/src/skill-lock.ts)

We adopted explicit Agent directory knowledge, Agent detection, symlink/copy installation modes and a lock/manifest view of installed Skills. We intentionally support only Codex, Claude Code and OpenCode in this release and freeze the selected target set after install. That narrower contract is easier to audit than silently projecting to every directory that later appears.
