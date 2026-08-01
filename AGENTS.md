# Repository instructions

This repository implements a free, Git-native, cross-Agent thin protocol. Keep the product boundary narrow: reviewed incident and invariant sources are related to current diff paths and exact project-native commands; the CLI issues deterministic facts and checks Agent-attested results.

## Public surface

Only these commands are public:

```text
hy-workflow helper install|update|status|remove [--json]
hy-workflow inspect --json
hy-workflow verify --input-file <evidence.json> --json
hy-workflow verify --input '<JSON object>' --json
hy-workflow --version
```

The installed bundle contains exactly `hy-init`, `hy-verify`, and `hy-capture`. Do not reintroduce phase, stage, route, PlanDoc, approval, scope lock, exam, Git/GitHub orchestration, project registration, MCP setup, built-in lint, injected workflows, private project state, or additional stage Skills.

## Product rules

- Skills guide Agent actions and explain meaning. The CLI validates deterministic structure, snapshots Git, issues exact argv, checks binding and expected exit codes, and manages user-level Skill ownership.
- A CLI status is a fact, never permission to start or stop Agent work. Invalid, stale, missing, or unavailable evidence prevents only a positive protocol-backed claim. Continue safe diagnosis, editing, and independently justified native checks.
- `verify` reports `agent_attested`; never describe it as cryptographic proof that a command ran.
- `hy-workflow.yml` is the only machine relation file. It contains no prompt, task state, user decision, raw output, CI result, or shell command string.
- Incident and invariant meaning stays in ordinary tracked Markdown; regression oracles stay in native test directories. Evidence stays outside Git.
- CLI path matching is a deterministic minimum. `hy-verify` performs semantic impact analysis and may add unsigned native checks, but it never removes an issued command.
- Select Small, Medium, and Large depth by affected boundary, not by duration. Small is required for substantive implementation changes; Medium covers cross-module/process/state/schema/API/CLI/config/concurrency/recovery boundaries; Large covers install/upgrade/package/release/CI/platform/external/security/irreversible compatibility and end-to-end historical incidents.

## Helper safety

Helper may write only its user-level canonical Skill root, ownership state, and exactly owned projections in detected global Agent Skill directories. It must work outside Git and must never modify a project, `.git`, project Agent configuration, MCP configuration, or GitHub Actions.

The 0.5 migration is a hard compatibility boundary: validate the legacy 12-Skill manifest, transactionally reach exactly 3 Skills, and remove the 10 obsolete resources only when their exact ownership and hashes still match. Preserve conflicts, foreign Skills, and all legacy project state.

## Development and release

Use `npm run verify` for the offline suite, `npm run test:acceptance:thin` for installed-package acceptance, and the networked `npm run test:acceptance:migration` for the public 0.5 upgrade oracle. Do not commit generated `dist` or `.tgz` files.

Release changes move by reviewed pull requests from a feature branch to `dev`, then from `dev` to `main`. Explicitly wait for Linux and Windows checks. A published `v<version>` GitHub Release triggers `.github/workflows/npm-publish.yml`; preserve its OIDC trusted-publisher filename and same-tarball SHA-512 chain. Confirm npm `latest`, attestations, fresh install, and 0.5-to-latest migration before declaring release complete.
