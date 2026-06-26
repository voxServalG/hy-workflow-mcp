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
- npm test
- npm run verify

CI runs build, workflow-contract lint, tests, doclint, and codelint.

