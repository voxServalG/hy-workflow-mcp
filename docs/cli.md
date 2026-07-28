# CLI Contract

The public package `@voxstudio/hy-workflow` exposes one bin: `hy-workflow`. Running it without a subcommand starts MCP stdio. Registry installs use the prebuilt npm tarball and never compile locally.

## Commands

- `hy-workflow`
- `hy-workflow --help`
- `hy-workflow --version`
- `hy-workflow setup`
- `hy-workflow unset`
- `hy-workflow setup --yes --clients codex,claude,opencode --json`
- `hy-workflow setup --yes --clients codex --ci-command 'npm ci' --ci-command 'npm test' --json`
- `hy-workflow setup --yes --clients codex --force-client-overwrite codex --json`
- `hy-workflow setup --yes --clients codex --migrate-legacy-clients --json`
- `hy-workflow unset --yes --clients all --remove-global --json`
- `hy-workflow config --check --json`
- `hy-workflow config --apply --json --docs-dir '<existing-project-relative-dir>'`
- `hy-workflow config --apply-suggested --json`
- `hy-workflow lint --json`
- `hy-workflow lint-contract`

`setup`/`unset` share one Node engine. The TUI immediately shows progress, then selects installed clients and binds confirmation to exact native CI commands and artifact before/after hashes. Non-interactive setup requires existing CI config or explicit repeatable `--ci-command`; artifact replacement additionally requires `--accept-artifact-changes` plus exact repeatable `--review-artifact` tuples from dry-run. Bare approval flags, stale hashes, dry-run and cancellation never authorize later values. There is no mode selector: team-owned repository surfaces are `hy-workflow.json`, `.github/workflows/hy-workflow.yml`, and the `<!-- hy-workflow-rules -->` managed block in `AGENTS.md` (content outside the markers is team-owned and preserved byte-for-byte), while deployment/state/cache/client config stay external.

## Config safety

`hy-workflow config --check --json` validates root config and evidence from Git-tracked files, manifests, multi-extension source directories and origin/current/conventional refs. `package.json` alone is not TypeScript evidence; material mixed/unknown/low-confidence Git inference requires explicit values. Optional `ci.commands` must be a non-empty bounded single-line string array and is preserved as a manual team choice.

`config --apply` preserves existing configuration and changes only explicitly supplied fields; it is the recovery command for replacing an invalid or missing `project.docsDir`. `config --apply-suggested` intentionally applies the detected project and lint defaults. Both validate before writing root `hy-workflow.json`. Malformed JSON, invalid field types, unsafe branch/path characters, unknown flags, missing values, or a docsDir that cannot be resolved to an existing directory return a structured nonzero result without writing. Suggested shell commands quote dynamic values and never recommend a command known to fail the same validation.

Root `codelint.json`, `doclint.json`, and `docs-gardener.json` remain legacy compatibility artifacts used only as read-only setup/config migration or drift inputs. `hy-workflow lint --json` reads the root unified config and never creates, modifies, or restores those files.

`hy-workflow lint --json` emits the `hy-workflow.lint.v1` report with ten D001–D005/C001–C005 checks. Warnings exit zero; any error, invalid configuration, supported parser failure, or configured-language zero scan exits one. Unsupported languages are explicit `not_applicable`, and absent tiers are `not_configured`.

The generated workflow runs only for pull requests or manual dispatch. It runs the confirmed `ci.commands` sequence followed by mandatory built-in offline doclint/codelint from a deterministic embedded bundle. Missing native commands, zero documentation files, timeout/failure, malformed lint evidence, no GitHub checks, or only skipped/neutral checks are not success. A repository administrator must separately mark Verify required; setup does not mutate administration settings.

## MCP tools

The MCP surface is canonical in `src/commands/catalog.ts` and registered by `src/server.ts`:

- `hy_init`, `hy_read_docs`, `hy_plan`, `hy_approve`
- `hy_branch`, `hy_edit`, `hy_sync_docs`, `hy_verify`, `hy_exam_plan`, `hy_exam_submit`, `hy_amend_plan`
- `hy_commit`, `hy_ci`, `hy_merge`, `hy_chain`, `hy_reset`, `hy_status`

Contract lint checks that README, tool docs, server registration, and tests agree on this surface.

Ordinary development preserves the complete documentation sequence: `hy_status -> hy_read_docs(before_plan) -> hy_plan -> hy_read_docs(before_approve) -> hy_approve -> hy_branch -> hy_edit -> hy_read_docs(after_edit) -> hy_sync_docs -> hy_verify -> hy_commit -> hy_ci -> hy_merge -> hy_chain -> hy_reset`.

## Long verification commands

Use hy_verify only for short suites. For verify:dev or acceptance, call hy_exam_plan, execute its exact commands outside the MCP transport, then submit bounded evidence with hy_exam_submit.
