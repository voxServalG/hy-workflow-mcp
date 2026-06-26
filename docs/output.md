# Output Contract

Every user-facing tool response is a single JSON envelope. `src/output/contract.ts` is the canonical field list; `src/output/envelope.ts` is the runtime helper and TypeScript shape. The contract is additive: tool-specific fields can remain, but agents should prefer the stable fields below instead of scraping prose from `message`.

## Output Envelope Fields

Top-level output fields are `ok`, `phase`, `next`, `status`, `data`, `error`, `display`, `summary`, `hint`, `requires_user`, `stop_here`, `allowedTools`, `blockedTools`, `recovery`, `checks`, `findings`, `pagination`, `meta`, and `_notice`.

- `ok`: boolean success flag. Failures return `ok: false` and an `error` object.
- `phase`: current workflow phase after the tool returns.
- `next`: suggested next phase or tool state. `phase` and `next` may differ when the workflow is still in the current phase but the next call is known.
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

Successful tools return `ok: true`, `phase`, `next`, and any tool-specific data. Tools that need a human decision set `requires_user` and `stop_here`. Tools that can continue automatically omit `stop_here` unless an API, CI, merge, permission, or recovery condition blocks the workflow. Agents should render `display` and `summary`, use `hint` and `recovery` to decide next actions, respect `allowedTools` and `blockedTools`, and carry `request_id` or `trace_id` into troubleshooting output.
