# Repository Verification Contract

This document describes how the hy-workflow package itself is accepted. [Verification Pipeline](./verify.md) describes one managed task's runtime evidence.

## Required local layers

- `npm run build`
- `npm run lint:contract`
- `npm run test:unit`
- `npm run test:e2e`
- `npm run test:contract`
- `npm test`
- `npm run verify`
- `npm run test:acceptance:baseline`
- `npm run verify:dev`
- `npm run test:windows`
- `npm pack --dry-run --json`
- release-only `npm run test:acceptance:pressure`
- release-only `npm run test:acceptance:migration -- --legacy @voxstudio/hy-workflow@0.4.0 --candidate <tgz-or-npm-spec>`

These commands are not interchangeable. Unit/e2e tests exercise source behavior; contract lint checks cross-file promises; baseline executes a packed package offline and synthesizes legacy migration state; Windows smoke checks the installed CLI/Skill lifecycle; release pressure runs the canonical tarball against pinned public repositories; the online migration oracle installs real public 0.4.0, creates its root `hy-workflow.json` and schema-3 state with no external authority marker, then migrates that state to the candidate.

## Change-scaled evidence

Every change needs Small evidence: build/static checks and focused unit/contract tests near the behavior. Add Medium evidence for module/process/storage/schema/CLI/configuration/concurrency/recovery boundaries. Add Large evidence for installation, migration, packaging, release, CI, cross-platform, security or historical incidents.

This CLI+Skill migration is Large. It requires installed-tarball fresh install, byte-preserving upgrade, exact MCP retirement, project-identity aliases/conflicts, Windows and POSIX Skill projection, stale commit-recovery supersession, five-repository lint pressure and post-publication `latest` verification. Source tests alone cannot close it.

## Development gate

`npm run verify:dev` is the expected pre-`dev` gate: normal verification plus the deterministic packed-tarball baseline. This repository's own CI decides when and where it runs. Helper does not create or update those workflows in consumer projects.

Do not claim the baseline passed from documentation or a source-only run. Preserve the command result and incident list as evidence.

## Long commands inside a managed task

When the package is being developed under hy-workflow, long baseline/pressure suites belong to the `hy-verify` Skill's asynchronous path:

1. call `hy-workflow exam-plan` when routed;
2. execute every exact issued command with its binding/nonce;
3. submit one complete result set with `hy-workflow exam-submit`;
4. after a repair, refresh post-edit documentation evidence and obtain a new exam.

Keep short focused checks in `hy-workflow verify`. Small/Medium/Large remains a semantic boundary classification, not a fixed 60-second rule.

## Release gate

The publish workflow must validate tag/main/prerelease provenance, build one tarball, record its SHA-512, run the no-skip pressure matrix and the real public 0.4.0 migration oracle against that exact archive, recheck its bytes and publish it with npm Trusted Publishing. Stable publication uses `latest`; prerelease uses `next`.

Release completion requires a green publish job, registry verification and a second isolated migration with `--candidate @voxstudio/hy-workflow@latest`. Creating a GitHub Release without npm/post-publication evidence is incomplete.

## CI ownership

This repository owns its native CI, acceptance baseline, Windows smoke and publish workflows. Consumer repositories own theirs. The optional packaged workflow template is not installed by helper and is not evidence that a consuming repository configured required checks.

See [Acceptance Gates](./acceptance.md), [NPM Packaging](./npm.md), and [Workflow Contract Lint](./lint-contract.md).
