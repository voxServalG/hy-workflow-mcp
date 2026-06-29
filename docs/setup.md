# Setup Artifact Contract

`setup` is the one-command bootstrap for hy-workflow projects. It is a standalone bash script that deploys tracked project artifacts and writes a setup stamp. Windows PowerShell users run the same script through `curl.exe -fsSL https://raw.githubusercontent.com/voxServalG/hy-workflow-mcp/main/setup | bash`; macOS, Linux, Git Bash, and WSL shell users run `curl -fsSL https://raw.githubusercontent.com/voxServalG/hy-workflow-mcp/main/setup | bash`.

PowerShell must use `curl.exe`, not `curl`, because Windows PowerShell 5.1 aliases `curl` to `Invoke-WebRequest` and does not understand `-fsSL`. The PowerShell command requires a Git for Windows `bash` on `PATH`; WSL users should run the bash command from inside the WSL shell.

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

`SETUP_VERSION` in `setup` and `src/bootstrap.ts` must match.
When setup content changes, the version must be bumped so downstream projects are prompted to refresh.
