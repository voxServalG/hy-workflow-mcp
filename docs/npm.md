# NPM Packaging Contract

`src/npm/package.ts` provides helpers for reading `package.json` and running `npm pack --dry-run`. The public package is `@voxstudio/hy-workflow`; its stable bin is `hy-workflow`.

## Required npm scripts

- `clean` — remove only the repository-root `dist/` with the cross-platform Node cleaner
- `build` — TypeScript compile (`tsc`)
- `lint:contract` — workflow contract lint
- `test` — full test suite
- `test:unit`, `test:e2e`, `test:contract` — test layers
- `test:acceptance` — mandatory release pressure suite; local runs may pack for themselves, while release runs must receive the workflow's canonical tarball through `--package-archive`
- `test:windows` — Windows-safe focused tests plus installed-tarball setup/repeat/unset smoke, run by the independent Windows Smoke CI job
- `verify` — build + tests
- `prepack` — build `dist/` immediately before creating the npm tarball
- `prepublishOnly` — require full verification before publication

There is no `prepare`, `install`, or `postinstall` build. Registry users receive a tarball that already contains `dist/`; global installation never needs TypeScript or dev dependencies.

## Test runner dependency

`tsx` is a declared `devDependency` because every test-layer script executes TypeScript files through `npx tsx`. Declaring it keeps `npm ci` and `hy_verify` deterministic and prevents per-file remote npx resolution.

## Packaging rules

- `name` must be `@voxstudio/hy-workflow`, with public scoped-package access
- `bin["hy-workflow"]` and `main` must point at `dist/server.js`
- `files` must include `dist`, `docs`, `schemas`, `templates`, and `README.md`
- `dist/` and local `*.tgz` tarballs must not be tracked by Git
- npm pack must include `dist/server.js`, the project-config schema, `templates/hy-workflow.yml`, and the first-party lint engine
- npm pack must not include legacy `setup` or `setup.ps1`
- No `.hy/`, `.opencode/`, `.codex/`, `.mcp.json`, compatibility JSON, `test/`, or `src/` files may enter npm pack
- Every build/prepack begins from an empty `dist/`; consecutive packs must have the same file list and digests even after an orphan file is injected
- The installed `hy-workflow lint --json` command must run the packaged first-party engine without registry or codeload access and without mutating legacy compatibility JSON

## Generated workflow contract

The packaged `templates/hy-workflow.yml` is intentionally thin. Fresh setup replaces its single package placeholder with the exact current package spec, such as `@voxstudio/hy-workflow@0.4.1-next.6`. The committed workflow uses pull-request and manual triggers, `contents: read`, a SHA-pinned checkout with persisted credentials disabled, and one `hy-workflow lint --json` invocation through that exact package.

The runner may contact npm to obtain the pinned package. The workflow must not infer project ecosystems, install project toolchains, synthesize native CI commands, or rerun repository build/test jobs. Those remain separate repository-owned checks. The same boundary applies to `.github/workflows/reusable-verify.yml`: it calls an exact package version and grants no write permissions.

Package upgrades do not rewrite an already installed project's tracked workflow. In particular, setup does not inspect or hash a legacy workflow during an upgrade. A tracked old workflow may still be executed independently by GitHub until the repository removes or disables it in a separate reviewed change.

## Release boundary

`.github/workflows/npm-publish.yml` publishes GitHub Releases through npm Trusted Publishing on a GitHub-hosted runner. It requires `id-token: write`, fetches complete Git history, and fails before verification unless the release tag equals `v` plus `package.json.version`, the checked-out tag commit belongs to `origin/main`, and package semver prerelease state exactly matches GitHub `release.prerelease`. Only then may a prerelease use npm tag `next` or a stable release use `latest`. It does not use a long-lived npm token. After normal verification, the workflow creates exactly one canonical `.tgz`, records its SHA-512, passes that exact path into the no-skip acceptance matrix, verifies that its bytes did not change, and publishes that same `.tgz`. It never publishes the source directory after acceptance, so npm lifecycle hooks cannot silently replace the tested artifact. The tarball stays only in runner-temporary storage; the workflow must not use `actions/upload-artifact`, `gh release upload`, a GitHub Release asset, or a Git commit for compiled output.

The package must exist before npm can attach a trusted publisher. Bootstrap it once from the reviewed release commit with an authenticated local npm CLI and a prerelease version:

```bash
npm publish --access public --tag next
npm trust github @voxstudio/hy-workflow --file npm-publish.yml --repo voxServalG/hy-workflow-mcp --allow-publish
```

The first command publishes only to npm; it does not create or upload a GitHub build artifact. After the trusted publisher is confirmed, future GitHub Releases use OIDC only and the workflow enforces tag, branch ancestry, and prerelease-channel consistency before running the release gate.

These rules are enforced by `src/contralint/rules/npm.ts` and `test/contract/npm-package.ts`.

## Acceptance scripts

- test:acceptance:baseline: offline packed-tarball gate for dev.
- test:acceptance:pressure: five-public-repository release pressure.
- test:acceptance: compatibility alias for pressure.
- verify:dev: normal verify plus the dev baseline.
