# NPM Packaging Contract

`src/npm/package.ts` provides helpers for reading package.json and running npm pack dry-run.

## Required npm scripts

- `build` — TypeScript compile (tsc)
- `lint:contract` — workflow contract lint
- `test` — full test suite
- `test:unit`, `test:e2e`, `test:contract` — test layers
- `verify` — build + tests

## Packaging rules

- `files` must include `dist`, `docs`, `README.md`
- `bin["hy-workflow"]` must point at `dist/server.js`
- `main` must be `dist/server.js`
- No `.hy/`, `.opencode/`, `.codex/`, `.mcp.json`, `codelint.json`, `doclint.json`, `docs-gardener.json`, `test/`, or `src/` files in npm pack

These rules are enforced by `src/contralint/rules/npm.ts`.
