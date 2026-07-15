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
- `hy-workflow config --apply-suggested --json`
- `hy-workflow lint-contract`

`setup` and `unset` share one cross-platform Node engine. In a TTY, the `@clack/prompts` TUI detects Codex, Claude Code, and OpenCode and presents a client multiselect. In non-interactive use, `--yes` and explicit `--clients` are both required. `--dry-run` makes no writes; `--json` emits one result envelope. Local mode is default; `--shared` explicitly permits repository writes.

## Config safety

`hy-workflow config --check --json` validates the effective project config before tools use `project.baseBranch`, `project.docsDir`, `project.codeDirs`, and `codelint.lintDirs`. The effective source is a shared root `hy-workflow.json` when present, otherwise the identity-scoped config in the OS user config directory.

`config --apply-suggested` validates before writing the user-local config. Pass `--shared` to intentionally write `hy-workflow.json`. Malformed JSON, invalid field types, unsafe branch/path characters, unknown flags, or missing values return a structured nonzero result without writing. Suggested shell commands quote dynamic values.

Root `codelint.json`, `doclint.json`, and `docs-gardener.json` remain legacy compatibility artifacts. Where an older CLI requires them, hy-workflow materializes them only for the command and restores the previous project state.

## MCP tools

The MCP surface is canonical in `src/commands/catalog.ts` and registered by `src/server.ts`:

- `hy_init`, `hy_read_docs`, `hy_plan`, `hy_approve`
- `hy_branch`, `hy_edit`, `hy_sync_docs`, `hy_verify`, `hy_amend_plan`
- `hy_commit`, `hy_ci`, `hy_merge`, `hy_chain`, `hy_reset`, `hy_status`

Contract lint checks that README, tool docs, server registration, and tests agree on this surface.
