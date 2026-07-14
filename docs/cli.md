# CLI Contract

The scoped package `@voxserval/hy-workflow` exposes one bin entrypoint: `hy-workflow`. Install or update it with `npm install -g @voxserval/hy-workflow@latest`; running without a subcommand starts the MCP stdio server. `hy-workflow setup` runs the bundled project bootstrap script, and `hy-workflow --version` reads the installed package version. Registry installs use the prebuilt npm tarball and never compile locally.

## Commands

- hy-workflow
- hy-workflow --help
- hy-workflow --version
- hy-workflow config --check --json
- hy-workflow config --apply-suggested --json
- hy-workflow lint-contract

## Config Safety

`hy-workflow config --check --json` validates `hy-workflow.json` as the source of truth before workflow commands use `project.baseBranch`, `project.docsDir`, `project.codeDirs`, and `codelint.lintDirs`. Malformed JSON, invalid declared field types, unsafe branch/path characters, unknown flags, and missing flag values return a structured envelope instead of raw parser errors. Any `ok: false` config result exits nonzero.

`hy-workflow config --apply-suggested --json` and explicit apply commands validate the candidate config before writing `hy-workflow.json`; invalid values fail without writing. Suggested terminal commands quote every dynamic value with single quotes, including values containing semicolons, whitespace, or `${IFS}`-style text, so the displayed command is copyable without turning config values into shell syntax. Root compatibility files (`codelint.json`, `doclint.json`, `docs-gardener.json`) remain runtime artifacts: legacy CLI runs temporarily overwrite them from `hy-workflow.json` and restore or remove them afterwards.

## MCP Tools

The MCP tool surface is canonical in src/commands/catalog.ts and registered by src/server.ts. The current tools are:

- `hy_init`
- `hy_read_docs`
- `hy_plan`
- `hy_approve`
- `hy_branch`
- `hy_edit`
- `hy_sync_docs`
- `hy_verify`
- `hy_amend_plan`
- `hy_commit`
- `hy_ci`
- `hy_merge`
- `hy_chain`
- `hy_reset`
- `hy_status`

Contract lint checks that README.md, docs/tools.md, this CLI document, src/server.ts, and tests all agree on this tool surface.
