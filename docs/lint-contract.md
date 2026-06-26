# Workflow Contract Lint

workflow-contract lint is a first-class project lint layer. It checks contracts that generic TypeScript lint cannot express.

## Entrypoints

- Source: src/lint-contract/index.ts
- Built CLI: node dist/lint-contract/index.js
- npm script: npm run lint:contract
- Full local verification: npm run verify

## Severity

- hard_fail blocks verification.
- amend_required means docs, scope, or tests need alignment before approval or merge.
- warning gives maintainer signal without blocking the happy path.

## Rules

- tools: src/commands/catalog.ts, src/server.ts, README.md, docs/tools.md, docs/cli.md, and tests must agree on the MCP tool surface.
- errors: docs/errors.md and src/errors/catalog.ts must declare every stable type and subtype, and server catch paths must return structured envelopes.
- output: src/output/envelope.ts and docs/output.md must define the stable result and error envelope.
- workflow: src/runtime/state-machine.ts and docs/state-machine.md must agree on phases and transitions.
- artifacts: local runtime files such as .hy/, .opencode/, .codex/, .mcp.json, codelint.json, doclint.json, and docs-gardener.json must not be tracked.
- skills: docs/skills/core/SKILL.md must reference real tools and include workflow order, output, error, and recovery guidance.
- npm: package.json must expose clean scripts, bin, main, and minimal files; npm pack dry-run must not include local, test, source, or generated garbage.

