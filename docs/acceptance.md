# Acceptance Gates

Acceptance proves the installed npm artifact and migration behavior, not merely the source checkout. This document states required release evidence. A requirement is not considered satisfied until the corresponding suite has run successfully against the canonical tarball in CI or an equivalent recorded environment.

## Gate structure

The project has three complementary gates:

- `npm run test:acceptance:baseline` is the deterministic, offline development baseline. Its migration case synthesizes the known legacy state shape without downloading the old package. `npm run verify:dev` runs normal verification followed by this baseline.
- `npm run test:acceptance:pressure` is the release-only public-repository pressure suite. `npm run test:acceptance` is its compatibility alias.
- `npm run test:acceptance:migration -- --legacy @voxstudio/hy-workflow@0.4.0 --candidate <tgz-or-npm-spec>` is the online public migration oracle. It installs and operates the real public 0.4.0 package before replacing it with the candidate.

No gate may silently skip a declared scenario. Timeout, partial result, malformed envelope, missing oracle or unrecorded mutation fails closed. The offline synthetic fixture gives deterministic development coverage; it does not substitute for the online public-package oracle at release time.

## Canonical package boundary

The baseline, pressure suite and candidate side of the migration oracle must consume a packed package. Release pressure and the pre-publication migration oracle receive the exact archive built by the publish workflow. Required package oracles are:

- npm `main` and `bin["hy-workflow"]` execute `dist/main.js`;
- `dist/server.js` and an active MCP entrypoint are absent;
- exactly the 12 cataloged stage Skills are present;
- source, tests, local runtime directories and user/client state are absent;
- `hy-workflow lint --json` runs offline from the installed package;
- the package never mutates a project merely because npm installation occurred.

The acceptance harness isolates HOME/XDG/Agent config, npm prefix/cache/config and credentials. Remote write commands are rejected. Timeouts must terminate process trees on POSIX and Windows so an abandoned child cannot keep changing the worktree or `dist/`.

## Fresh helper installation oracle

Every representative fixture must run the installed helper in a clean Git worktree and prove:

1. `helper install` emits `hy-workflow.helper.v1` with explicit `skills`, `project` and `mcp` layers;
2. `projectFilesChanged` is exactly `[]` in every outcome;
3. the complete Skill bundle is installed only in isolated user roots and exact selected Agent targets;
4. project registration, config and state remain outside the worktree and Git common directory;
5. no `hy-workflow.json`, GitHub Actions workflow, `AGENTS.md`, `.mcp.json`, project Agent directory, `.hy/` or compatibility lint JSON is created;
6. a repeated install converges without rewriting unchanged resources;
7. `helper status` reports the same bundle hash, targets and external project identity;
8. `init` returns local cognition and changes no project file or Git metadata;
9. `helper remove` removes only owned Skill resources and preserves external project state.

Target coverage must include Codex, Claude Code and OpenCode, symlink and copy behavior where supported, and explicit target selection when detection is empty.

## Skill ownership and fault oracles

The baseline must inject failures around staging, projection and manifest replacement. After each failure, it compares the full isolated user-state fingerprint and proves either rollback to the exact pre-state or a structured partial result with truthful completed layers and exact recovery argv.

It must also prove:

- unmanaged same-name content is not overwritten or removed;
- target paths cannot escape to the project, `.git` or an unsafe root;
- normal update preserves an intentionally deleted projection;
- `update --repair` restores only the recorded missing projection;
- target set and projection preference cannot change during update;
- concurrent operations serialize or return structured retryable contention;
- remove uses current hashes and refuses ownership drift.

## Seamless MCP-to-CLI migration oracle

`INC-UPGRADE-INJECTION-INTERFERENCE` is the mandatory offline compatibility fixture, and the public migration oracle independently exercises the same boundary with the real package published as `@voxstudio/hy-workflow@0.4.0`. The legacy starting point has a repository-root `hy-workflow.json`, a schema-3 deployment and registry/client ownership, active workflow/scope/approval/verification state, owned MCP entries and no external runtime-config authority marker. Migration may create exactly that external marker, declaring the unchanged root `hy-workflow.json` as project authority. It must otherwise prove:

- Skills are available before legacy MCP retirement is attempted;
- on an unmoved checkout, the root `hy-workflow.json`, schema-3 deployment and registry, workflow state and scope are byte-for-byte identical after helper install;
- the newly created external authority marker is the only permitted external state addition;
- the current phase, approval, verified evidence and worktree are preserved;
- client configuration and ownership change only by removing the exactly owned `hy-workflow` MCP entry;
- `docs-gardener`, unrelated MCP definitions, project overrides and unowned same-name content are unchanged;
- failure during retirement rolls back owned client configuration or returns a recovery-required layer without reporting success;
- old tracked project config/workflow/AGENTS/client/lint artifacts remain byte-for-byte unchanged;
- helper remove does not restore the retired MCP entry or delete preserved project state.

Equivalent GitHub SSH/HTTPS/default-port/case/`.git` locator spellings must resolve to one project identity. A single legacy raw-locator deployment continues without copied state; simultaneous canonical/legacy or multiple legacy candidates must return `PROJECT_IDENTITY_CONFLICT`.

If the checkout genuinely moved, helper status remains read-only and reports the exact `helper install --json` recovery command. Install may then reconcile only deployment and registry identity fields in one transaction after proving a unique safe alias; external config, workflow, scope, cache, DocsGraph and client ownership remain unchanged. Equivalent remote spelling changes within the same checkout must not rewrite deployment or registry bytes.

## Local cognition oracle

`init` acceptance uses repositories with Node/TypeScript, Python, Rust and mixed/nonstandard layouts. The result must identify locally supported ecosystems, candidate commands, documentation entry points, branch/head/upstream/dirty facts, recent commits and merge commits, and the fixed test-scale contract.

Network, Feishu/Lark and remote PR access are disabled in this scenario. Missing evidence is represented as unavailable. Candidate commands are observations, not passing-test claims. Worktree and `.git` fingerprints must remain unchanged.

## Test-scale and verification oracle

Fixtures must bind change characteristics to expected semantic scale:

- every change has Small checks;
- cross-module, process, storage, schema, API, CLI, configuration, concurrency or recovery changes add Medium checks;
- installation, migration, packaging, release, CI, cross-platform, external-service, security or historical-incident changes add Large checks.

The suite verifies that CLI-required checks cannot be dropped and that synchronous verify and asynchronous `exam-plan`/`exam-submit` persist equivalent implementation manifest/digest evidence. A successful new verification must supersede stale commit-recovery state; a failed or incomplete verification must preserve it.

## Commit and merge incidents

Release acceptance retains incident fixtures for the failure modes that motivated recovery logic.

Commit recovery must prove that a failure after commit creation cannot cause a second commit on retry, while any mismatch in repository, branch, base, HEAD or verified digest fails closed. After a repair and successful re-verification, the stale recovery record must no longer hijack publication.

`INC-MERGE-UNKNOWN-OUTCOME` must prove:

- immutable repository/PR/base/head/verified-OID identity is separate from mutable lifecycle;
- an attempted receipt is persisted before the sole merge mutation and a confirmed receipt after remote confirmation;
- a retry reconciles GitHub state or fresh-fetch ancestry and does not repeat the mutation;
- the read-only Git fallback never merges or pushes the base;
- downstream candidates are real proven stacks, not unrelated branches;
- confirmed sync pins `syncBaseOid`, computes rebases in detached staging, installs local refs by compare-and-swap and pushes by exact force-with-lease;
- local/remote drift fails closed and cannot be overwritten;
- `POST_MERGE_SYNC_INCOMPLETE` reports completed/remaining work and resumes only the remainder;
- terminal outcomes distinguish `merged_now`, `already_merged` and `already_integrated` with actual executor evidence.

The incident promises recovery after persisted state boundaries and ordinary process interruption. It does not claim power-loss durability beyond the implementation's explicit write guarantees.

## Release pressure repositories

The release matrix uses five public repositories pinned by full commit: Vite, Flask, Express, GitHub CLI and ripgrep. The release workflow checks out those commits and passes local mirror paths to the runner; a local invocation may use the matching `HY_ACCEPTANCE_*_MIRROR` variables or bounded HTTPS acquisition.

For every repository, the installed package must run real doclint/codelint pressure, report `hy-workflow.lint.v1` deterministically, distinguish passed/failed/warning/not-applicable/not-configured rules, reject zero-scan false green, and preserve all compatibility bytes. The validator must also require the retired dependency slots to stay fixed at `C003=not_configured` and `C004=not_applicable`, with no findings. Pressure setup must use helper's zero-project-write contract, not the removed two-artifact setup behavior.

## CI and release evidence

Acceptance is not itself installed into consumer repositories. This repository owns its development and release workflows. The npm publish job must validate tag/main ancestry, build exactly one tarball, record its SHA-512, run release pressure against that exact path, run the online public 0.4.0-to-tarball migration oracle, recheck the digest and publish the same bytes.

A stable release is complete only after the publish job is green, npm shows the released version under `latest`, and the online oracle is repeated with `--candidate @voxstudio/hy-workflow@latest`. A GitHub Release alone is not sufficient evidence.

## Long-suite execution in a managed workflow

When hy-workflow is used to develop this repository, acceptance belongs to Large verification. The active `hy-verify` Skill should use `exam-plan`, execute every issued command exactly with its nonce/binding, and submit one complete result set through `exam-submit`. Do not run the long suite through the synchronous `verify` path. Any implementation change invalidates the old exam and requires refreshed post-edit/documentation evidence plus a new exam.
