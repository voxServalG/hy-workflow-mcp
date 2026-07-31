# Output Contract

Every user-facing tool response is a single JSON envelope. `src/output/contract.ts` is the canonical field list; `src/output/envelope.ts` is the runtime helper and TypeScript shape. The contract is additive: tool-specific fields can remain, but agents should prefer the stable fields below instead of scraping prose from `message`.

## Output Envelope Fields

Every result has typed additive `phase`, `stage`, `status`, `nextAction`, `control`, and `userAction`, and preserves legacy `next`. Existing `ok`, `data`, `error`, `display`, `summary`, `hint`, `requires_user`, `stop_here`, `allowedTools`, `blockedTools`, `recovery`, `checks`, `findings`, `pagination`, `meta`, and `_notice` remain additive.

- `ok`: boolean success flag. Failures return `ok: false` and an `error` object.
- `phase`: current workflow phase after the tool returns.
- `stage`: current intra-phase step; `phase` remains persisted coarse state.
- `nextAction`: nested `tool`, `arguments`, `phase`, `stage`, and `automatic`.
- `control`: nested `automatic`, `stop`, and `reason`.
- `userAction`: nested `kind`, `decisionId`, `prompt`, `instruction`, and `options`.
- `next`: legacy suggested next phase or tool state.
- `status`: stable machine-readable status such as `passed`, `pending`, `failed`, `blocked`, or `amend_required`.
- `data`: primary machine-readable payload when a tool has a domain result that should not be mixed into control fields.
- `error`: structured error envelope on failure.
- `display`: user-facing text and references with `title`, `body`, `files`, and `urls`.
- `summary`: long-form approval or review text that must be shown exactly when a tool requires it.
- `hint`: instruction for the agent, not the user-facing message.
- `requires_user`: explicit human input is required before automatic progress.
- `stop_here`: the agent must stop automatic progress in the current turn.
- `allowedTools`: tools the agent may call next.
- `blockedTools`: tools the agent must not call next.
- `recovery`: targeted repair guidance with `tool`, `command`, `instruction`, and `byLayer`.
- `checks`: verification or CI check records.
- `findings`: lint, audit, or review findings.
- `pagination`: paged result state with `has_more`, `page_token`, and `next_page_token`.
- `meta`: execution metadata with `command`, `cwd`, `identity`, `format`, `version`, `request_id`, `trace_id`, and `duration_ms`.
- `_notice`: compatibility notices. Update notices use `update.message`, `update.command`, `update.current_version`, and `update.latest_version`.

## Error Envelope

Failures return `ok: false`, preserve the current `phase` and suggested `next`, and include `error`. The nested error fields are `type`, `subtype`, `code`, `message`, `hint`, `detail`, `cause`, `retryable`, `risk`, `permission_violations`, `missing_scopes`, `console_url`, `request_id`, and `trace_id`. The subtype must exist in `docs/errors.md` and `src/errs/catalog.ts`; the server catch block must not return a bare string error.

## Result Behavior

Only `userAction.kind: "approval"` means ask the human to approve. Recovery, `requires_user`, `stop_here`, CI wait, `review_failure`, configuration, authentication, permissions, and external action retain distinct meanings and must not be rewritten as approval. Agents obey `control`, route by `nextAction`, render `display`/`summary`, preserve recovery and diagnostic details, and use legacy `next` only for compatibility.
