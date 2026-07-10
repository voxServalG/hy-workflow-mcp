# Setup Artifact Contract

`setup` is the one-command bootstrap for hy-workflow projects. It is a standalone bash script that deploys tracked project artifacts and writes a setup stamp. Windows PowerShell users run the same script through `curl.exe -fsSL https://raw.githubusercontent.com/voxServalG/hy-workflow-mcp/main/setup | bash`; macOS, Linux, Git Bash, and WSL shell users run `curl -fsSL https://raw.githubusercontent.com/voxServalG/hy-workflow-mcp/main/setup | bash`.

PowerShell must use `curl.exe`, not `curl`, because Windows PowerShell 5.1 aliases `curl` to `Invoke-WebRequest` and does not understand `-fsSL`. The PowerShell command requires a Git for Windows `bash` on `PATH`; WSL users should run the bash command from inside the WSL shell.

## Runtime prerequisites

- `git` must be installed and on `PATH` for branch, commit, push, pull and rebase operations.
- `gh` must be installed, on `PATH`, and authenticated with `gh auth login` for PR creation, CI status and merge operations.
- `hy_status` reports the startup capability snapshot. Each operation rechecks its required CLI before execution.
- There is no hidden internal Git or GitHub fallback. Missing capabilities fail closed with installation or login guidance.

## MCP package address contract

The setup prompt must tell agents to configure both MCP servers with explicit HTTPS Git package addresses:

- `npx -y --prefer-online git+https://github.com/voxServalG/hy-workflow-mcp.git#main`
- `npx -y --prefer-online git+https://github.com/voxServalG/docs-gardener.git mcp`

Do not use the `github:owner/repo` shorthand in the setup prompt. npm can resolve that shorthand to `git+ssh://git@github.com/...`, which makes MCP startup depend on GitHub SSH connectivity. The explicit `git+https` form keeps package retrieval on HTTPS.

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

Downstream projects that run `setup` get this complete CI pipeline.

## Version

`SETUP_VERSION` in `setup` and `src/bootstrap.ts` must match. When setup content changes, including either MCP package address, the version must be bumped so downstream projects are prompted to refresh and rerun the canonical HTTPS setup command.

The MCP runtime checks the setup stamp before every `hy_*` tool dispatch, not only once per process. `hy_init` also verifies the setup stamp version after confirming required artifacts exist; a missing, unreadable, or outdated stamp returns the structured setup refresh envelope and does not proceed to config validation.
