# CLI Contract

The public package `@voxstudio/hy-workflow` exposes one bin: `hy-workflow`. Running it without a subcommand starts MCP stdio. Registry installs use the prebuilt npm tarball and never compile locally.

## Commands

- `hy-workflow`
- `hy-workflow --help`
- `hy-workflow --version`
- `hy-workflow setup`
- `hy-workflow unset`
- `hy-workflow setup --yes --clients codex,claude,opencode --json`
- `hy-workflow unset --yes --clients all --remove-global --json`
- `hy-workflow config --check --json`
- `hy-workflow config --apply --json --docs-dir '<existing-project-relative-dir>'`
- `hy-workflow config --apply-suggested --json`
- `hy-workflow lint-contract`

`setup` and `unset` share one cross-platform Node engine. In a TTY, the `@clack/prompts` TUI detects Codex, Claude Code, and OpenCode and presents a client multiselect. In non-interactive use, `--yes` and explicit `--clients` are both required. `--dry-run` makes no writes; `--json` emits one result envelope. Setup has no mode selector and always maintains exactly `hy-workflow.json` plus `.github/workflows/hy-workflow.yml`; deployment/state/cache and client configuration remain external. For one compatibility release, hidden `--shared` is accepted as a no-op while `--local` returns an explicit migration error; neither appears in public help or the TUI.

## Config safety

`hy-workflow config --check --json` validates root `hy-workflow.json` before tools use `project.baseBranch`, `project.docsDir`, `project.codeDirs`, and `codelint.lintDirs`. Legacy identity-scoped user config is a read-only migration input, not a second effective source.

`config --apply` preserves existing configuration and changes only explicitly supplied fields; it is the recovery command for replacing an invalid or missing `project.docsDir`. `config --apply-suggested` intentionally applies the detected project and lint defaults. Both validate before writing root `hy-workflow.json`. Malformed JSON, invalid field types, unsafe branch/path characters, unknown flags, missing values, or a docsDir that cannot be resolved to an existing directory return a structured nonzero result without writing. Suggested shell commands quote dynamic values and never recommend a command known to fail the same validation.

Root `codelint.json`, `doclint.json`, and `docs-gardener.json` remain legacy compatibility artifacts. Where an older CLI requires them, hy-workflow materializes them only for the command and restores the previous project state.

The generated workflow runs doclint and codelint as mandatory CI gates. `hy_ci` does not interpret missing checks or only skipped/neutral checks as success. A repository administrator must separately mark the Verify check as required in GitHub rulesets or branch protection; setup does not mutate repository administration settings.

## MCP tools

The MCP surface is canonical in `src/commands/catalog.ts` and registered by `src/server.ts`:

- `hy_init`, `hy_read_docs`, `hy_plan`, `hy_approve`
- `hy_branch`, `hy_edit`, `hy_sync_docs`, `hy_verify`, `hy_amend_plan`
- `hy_commit`, `hy_ci`, `hy_merge`, `hy_chain`, `hy_reset`, `hy_status`

Contract lint checks that README, tool docs, server registration, and tests agree on this surface.

Ordinary development preserves the complete documentation sequence: `hy_status -> hy_read_docs(before_plan) -> hy_plan -> hy_read_docs(before_approve) -> hy_approve -> hy_branch -> hy_edit -> hy_read_docs(after_edit) -> hy_sync_docs -> hy_verify -> hy_commit -> hy_ci -> hy_merge -> hy_chain -> hy_reset`.
