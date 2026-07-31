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
- output: `src/output/contract.ts` is canonical. Every result preserves legacy `next` and adds typed `phase`, `stage`, `status`, `nextAction`, `control`, and `userAction`, plus display/recovery/pagination/meta/notice/error details. Missing or skipped/neutral-only checks remain fail closed with `CI_CHECKS_REQUIRED` in `hy_commit` stage `commit.ci`.
- workflow: phase is coarse persisted state and stage is the intra-phase step. The public sequence is status → document gates → plan/approve → branch/edit → verify or exam → commit including CI → merge including sync → reset.
- setup: fresh setup creates exactly `hy-workflow.json` and a small exact-version `.github/workflows/hy-workflow.yml`. It never injects `AGENTS.md` or migrates project client files. The workflow uses pinned checkout/read-only contents and centralized package lint/policy; native CI remains repository-owned.
- upgrade: acceptance proves legacy root config, workflow, AGENTS block, `.hy/`, project clients, and old lint JSON remain byte-for-byte untouched and non-authoritative while external stage/scope/approval/worktree are preserved.
- artifacts: local runtime files such as .hy/, .opencode/, .codex/, .mcp.json, codelint.json, doclint.json, and docs-gardener.json must not be tracked.
- skills: docs/skills/core/SKILL.md must reference real tools and include workflow order, output, error, and recovery guidance.
- npm: package.json must expose cross-platform clean/build/test/acceptance scripts and the built-in `hy-workflow lint --json` CLI, keep bin at dist/server.js, and package the workflow plus lint templates; dist must not be tracked, reproducible pack must reject orphan output, and release acceptance must precede direct npm publish without GitHub artifact upload.
