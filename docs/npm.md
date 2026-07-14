# NPM Packaging Contract

`src/npm/package.ts` provides helpers for reading `package.json` and running `npm pack --dry-run`. The public package is `@voxserval/hy-workflow`; its stable bin is `hy-workflow`.

## Required npm scripts

- `build` — TypeScript compile (`tsc`)
- `lint:contract` — workflow contract lint
- `test` — full test suite
- `test:unit`, `test:e2e`, `test:contract` — test layers
- `verify` — build + tests
- `prepack` — build `dist/` immediately before creating the npm tarball
- `prepublishOnly` — require full verification before publication

There is no `prepare`, `install`, or `postinstall` build. Registry users receive a tarball that already contains `dist/`; global installation never needs TypeScript or dev dependencies.

## Test runner dependency

`tsx` is a declared `devDependency` because every test-layer script executes TypeScript files through `npx tsx`. Declaring it keeps `npm ci` and `hy_verify` deterministic and prevents per-file remote npx resolution.

## Packaging rules

- `name` must be `@voxserval/hy-workflow`, with public scoped-package access
- `bin["hy-workflow"]` and `main` must point at `dist/server.js`
- `files` must include `dist`, `docs`, `setup`, `setup.ps1`, and `README.md`
- `dist/` and local `*.tgz` tarballs must not be tracked by Git
- npm pack must include `dist/server.js`
- No `.hy/`, `.opencode/`, `.codex/`, `.mcp.json`, compatibility JSON, `test/`, or `src/` files may enter npm pack

## Release boundary

`.github/workflows/npm-publish.yml` publishes GitHub Releases through npm Trusted Publishing on a GitHub-hosted runner. It requires `id-token: write`, uses `next` for prereleases and `latest` for stable releases, and does not use a long-lived npm token. The runner compiles `dist/` temporarily and passes it directly into `npm publish`; it must not use `actions/upload-artifact`, `gh release upload`, a GitHub Release asset, or a Git commit for compiled output.

The package must exist before npm can attach a trusted publisher. Bootstrap it once from the reviewed release commit with an authenticated local npm CLI and a prerelease version:

```bash
npm publish --access public --tag next
npm trust github @voxserval/hy-workflow --file npm-publish.yml --repo voxServalG/hy-workflow-mcp --allow-publish
```

The first command publishes only to npm; it does not create or upload a GitHub build artifact. After the trusted publisher is confirmed, future GitHub Releases use OIDC only. The release tag must equal `v` plus `package.json.version`.

These rules are enforced by `src/contralint/rules/npm.ts` and `test/contract/npm-package.ts`.
