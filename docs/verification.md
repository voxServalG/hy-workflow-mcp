# Verification Contract

Verification has two layers of meaning:

1. hy_verify checks a single approved task before commit.
2. workflow-contract lint checks that hy-workflow-mcp itself still keeps its agent-facing product contract.

## Required Local Commands

- npm run build
- npm run lint:contract
- npm run test:unit
- npm run test:e2e
- npm run test:contract
- npm run test:acceptance
- npm run test:windows
- npm pack --dry-run --json
- npm test
- npm run verify

Ordinary CI runs build, contract lint, tests, confirmed native project checks, doclint, and codelint. The package repository also runs an independent Windows Smoke job that builds and tests the installed tarball through setup, repeated setup, and unset. npm release additionally runs the full acceptance pressure matrix before publish; no skipped mandatory case is success.
