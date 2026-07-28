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

Ordinary CI runs build, contract lint, tests, confirmed native project checks, then the package's built-in offline doclint and codelint rules. The generated generic workflow is pull-request/manual only and treats lint errors, invalid reports, and zero documentation scans as failures. The package repository also runs an independent Windows Smoke job that builds and tests the installed tarball through lint, setup, repeated setup, and unset. npm release additionally runs the full acceptance pressure matrix before publish; no skipped mandatory case is success.

## Project acceptance

npm run verify:dev adds the offline packed-tarball acceptance baseline before code enters dev. Because it is long-running, execute it through hy_exam_plan and hy_exam_submit; keep hy_verify as the under-60-second path.
