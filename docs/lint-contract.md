# Workflow Contract Lint

workflow-contract lint is a first-class project lint layer. It checks contracts that generic TypeScript lint cannot express.

## Entrypoints

- Source: src/contralint/index.ts
- Built CLI: node dist/contralint/index.js
- npm script: npm run lint:contract
- Full local verification: npm run lint:contract

## Severity

- hard_fail blocks verification.
- amend_required means docs, scope, or tests need alignment before approval or merge.
- warning gives maintainer signal without blocking the happy path.

## Rules

- tools: src/commands/catalog.ts, src/server.ts, README.md, docs/tools.md, docs/cli.md, and tests must agree on the MCP tool surface.
- errors: docs/errors.md, src/errs/catalog.ts, src/errs/structured.ts, and src/output/contract.ts must agree on error types, subtypes, and error envelope fields including type, subtype, code, message, hint, detail, cause, retryable, risk, permission_violations, missing_scopes, console_url, request_id, and trace_id. Server catch paths must return structured envelopes.
- output: src/output/contract.ts is the canonical output envelope field list; src/output/envelope.ts and docs/output.md, docs/tool-result-envelope.md, docs/state-machine.md, and docs/skills/core/SKILL.md must document ok, phase, next, status, data, error, display, summary, hint, requires_user, stop_here, allowedTools, blockedTools, recovery, checks, findings, pagination, meta, and _notice, including nested display, recovery, pagination, meta, and _notice update fields.
- workflow: src/runtime/state-machine.ts and docs/state-machine.md must agree on phases and transitions.
- artifacts: local runtime files such as .hy/, .opencode/, .codex/, .mcp.json, codelint.json, doclint.json, and docs-gardener.json must not be tracked.
- skills: docs/skills/core/SKILL.md must reference real tools and include workflow order, output, error, and recovery guidance.
- npm: package.json must expose clean scripts, bin at dist/server.js, and minimal files including templates; dist must not be tracked by git; npm pack must exclude legacy installers, local, test, and source files.
