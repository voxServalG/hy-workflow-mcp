# Setup Artifact Contract

Install or update both scoped packages globally, then run the bundled setup command from the target project root:

```bash
npm install -g @voxserval/hy-workflow@latest @voxserval/docs-gardener@latest
hy-workflow setup
```

For mainland network routing, the install command may instead be:

```bash
npm install -g @voxserval/hy-workflow@latest @voxserval/docs-gardener@latest --registry=https://registry.npmmirror.com
hy-workflow setup
```

The npm package contains the standalone bash `setup` implementation. `hy-workflow setup` invokes that bundled file; it does not download code from GitHub. Windows requires Git for Windows `bash` on `PATH`.

## Runtime prerequisites

- Node.js 18 or newer and npm must be installed.
- `git` must be installed and on `PATH` for branch, commit, push, pull and rebase operations.
- `gh` must be installed, on `PATH`, and authenticated with `gh auth login` for PR creation, CI status and merge operations.
- `hy_status` reports the startup capability snapshot. Each operation rechecks its required CLI before execution.
- There is no hidden internal Git or GitHub fallback. Missing capabilities fail closed with installation or login guidance.

## MCP command contract

MCP clients run the globally installed bins directly:

- `hy-workflow`: command `hy-workflow`, no arguments
- `docs-gardener`: command `docs-gardener`, arguments `["mcp"]`

Do not use `npx`, a GitHub repository address, or SSH in the MCP client configuration. Package download and update are explicit npm HTTPS operations, not part of MCP startup.

## Tracked artifacts deployed by setup

- `.github/workflows/hy-workflow.yml` — single CI workflow
- `hy-workflow.json` — unified project config
- `.gitignore` — local artifact ignores
- `.git/hy-workflow/setup.json` — setup stamp (not tracked)

## CI workflow contract

The generated GitHub Actions workflow runs:

1. `npm ci`
2. `npm run build` (via package CI runner)
3. `npm run lint:contract` if defined (via package CI runner)
4. `npm test` if defined (via package CI runner)
5. doclint (always)
6. codelint (always)

Downstream projects that run `hy-workflow setup` get this complete CI pipeline.

## Version and downstream migration

`SETUP_VERSION` in `setup` and `src/bootstrap.ts` must match. When setup content or either MCP command changes, the version must be bumped. Existing GitHub-npx downstreams fetch the new package on restart, see the outdated setup stamp, and receive the explicit npm install/update plus `hy-workflow setup` recovery commands.

The MCP runtime checks the setup stamp before every `hy_*` tool dispatch, not only once per process. `hy_init` also verifies the setup stamp version after confirming required artifacts exist; a missing, unreadable, or outdated stamp returns the structured setup refresh envelope and does not proceed to config validation.
