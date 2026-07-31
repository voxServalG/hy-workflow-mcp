# Workflow Contract Lint

Workflow contract lint checks relationships that generic TypeScript lint cannot express. It protects the CLI+Skill public surface, external-state safety, migration invariants and package contents from drifting independently.

## Entrypoints

- Source: `src/contralint/index.ts`
- Built entrypoint: `node dist/contralint/index.js`
- npm script: `npm run lint:contract`
- Full local verification: `npm run lint:contract` as part of the repository's normal gates

This maintainer check is separate from `hy-workflow lint --json`, which is the first-party doclint/codelint command for consuming projects.

## Severity

- `hard_fail`: an executable safety or public-surface contract is broken.
- `amend_required`: documentation, tests or declared scope no longer describes the implementation completely.
- `warning`: maintainer signal that does not by itself block the happy path.

Release gates should treat unresolved hard failures and required amendments as incomplete work.

## Rule families

### Commands and workflow

`src/commands/catalog.ts`, `src/cli/workflow.ts`, handler modules and contract tests must agree on exactly 15 public CLI commands. Internal compatibility action names may bind the unchanged kernel, but they cannot appear as an additional public transport. `ci` remains stage `commit.ci`; downstream chaining remains `merge.sync`.

The canonical state machine defines phases/stages. Public state-machine, architecture and command docs must include every phase, normal route and merge recovery invariants. `src/server.ts`, `StdioServerTransport` and a server connection are forbidden in the public entrypoint.

### Skills

`src/skills/catalog.ts`, `skills/*/SKILL.md` and package tests must agree on exactly 12 Skills. Every Skill names its public `hy-workflow <command>` calls, declares CLI authority, requires exact argv and forbids private-state access. MCP-era prose fields and transport calls are forbidden.

The obsolete all-in-one `docs/skills/core/SKILL.md` is not a package Skill and must not return. Procedure is split across the phase Skills.

### Setup and migration

`src/main.ts` routes `setup` to `helper install`. Helper installation must expose three layers, install Skills before project registration/MCP retirement, keep `projectFilesChanged: []`, and reject resources inside the project or `.git`. Public helper code must not call the legacy shared-artifact renderer or mention `AGENTS.md`/the old workflow path as write targets.

Migration tests must prove existing deployment/config/workflow state/scope byte preservation, canonical remote identity, exact ownership retirement, `docs-gardener` preservation, partial recovery and one-way removal. The optional least-privilege workflow template may remain packaged for teams that deliberately adopt it, but helper never renders or injects it.

### Output and errors

`src/output/contract.ts` and the kernel envelope remain the compatibility source for handler fields. `src/cli/workflow.ts` must project them into `hy-workflow.cli.v1`, preserve facts and structured errors, map routes to public command argv arrays, and explicitly suppress `display`, `summary`, `hint`, prompt/instruction and shell-command prose.

`docs/errors.md`, the error catalog and structured error implementation must contain the same types, subtypes and envelope fields: `type`, `subtype`, `code`, `message`, `hint`, `detail`, `cause`, `retryable`, `risk`, `permission_violations`, `missing_scopes`, `console_url`, `request_id`, and `trace_id`. The public CLI excludes `hint` from projection while retaining the other structured facts.

### Verification and recovery

Contracts check scope/boundary failure behavior, Small/Medium/Large Skill procedure, canonical implementation digest use, asynchronous exam binding, stale commit-recovery supersession, CI fail-closed behavior, exact commit/PR identity and single-mutation merge receipts.

Merge implementation and docs must retain fresh-fetch ancestry, read-only Git fallback, detached staging, compare-and-swap and exact force-with-lease. Missing/no-effective CI checks remain `CI_CHECKS_REQUIRED` when CI evidence is active.

### Artifacts and lint

Generated `dist/` and user/runtime/client artifacts must not be tracked. Built-in lint must be offline, deterministic, first-party and non-mutating. It never materializes `codelint.json`, `doclint.json` or `docs-gardener.json`; dependency lint is not part of the current common contract. The ten-rule output remains stable by fixing `C003` to `not_configured` and `C004` to `not_applicable`, with no findings from either slot.

### npm and acceptance

`package.json` must point both main/bin at `dist/main.js`, include `skills`, and exclude the removed server entrypoint. A reproducible pack includes exactly the 12 Skills plus runtime, docs, the configuration schema and templates, and rejects source, tests, local artifacts and orphan `dist` files.

The release workflow validates tag/main/prerelease provenance, tests one canonical tarball and publishes those exact bytes through npm Trusted Publishing. Acceptance contracts require zero-project-write helper install, CLI-only cognition/docs calls, byte-preserving migration and installed-tarball lint pressure. Documentation may describe these as required oracles before execution; only CI results can claim that they passed.

## Adding or changing a public behavior

Update the canonical catalog or schema, implementation, appropriate phase Skill, public docs and focused contract/acceptance test in the same change. A new human-facing procedure belongs in a Skill. A new state/evidence invariant belongs in the CLI/kernel. A repository policy example belongs in docs, not in helper's default writes.
