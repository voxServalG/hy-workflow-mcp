# CLI Contract

The package exposes one bin entrypoint: hy-workflow. Running it without a subcommand starts the MCP stdio server from dist/server.js.

## Commands

- hy-workflow
- hy-workflow --help
- hy-workflow --version
- hy-workflow config --check --json
- hy-workflow config --apply-suggested --json
- hy-workflow lint-contract

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

