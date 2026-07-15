# Error Contract

User-facing failures must use a structured error object. A string may be passed inside implementation helpers, but the tool boundary normalizes it before returning JSON to the MCP client. Error types and subtypes are declared in `src/errs/catalog.ts`; the field contract is declared in `src/output/contract.ts`; the runtime shape is `StructuredError` in `src/errs/structured.ts`.

## Error Types

- validation
- workflow_state
- scope
- docs
- verification
- config
- io
- internal

## Error Subtypes

- `invalid_arguments`
- `invalid_plan`
- `invalid_command`
- `unknown_tool`
- `invalid_phase`
- `invalid_transition`
- `approval_missing`
- `scope_drift`
- `scope_amend_required`
- `docs_missing`
- `docs_stale`
- `sync_missing`
- `check_failed`
- `contract_failed`
- `setup_update_required`
- `setup_artifacts_missing`
- `harness_missing`
- `config_invalid`
- `artifact_tracked`
- `package_invalid`
- `io_failure`
- `uncaught_exception`

## Error Envelope Fields

Each returned failure has top-level `ok: false`, `phase`, `next`, and `error`. The nested `error` object contains these stable fields when applicable:

- `type`: broad recovery class from the Error Types list.
- `subtype`: precise recovery reason from the Error Subtypes list.
- `code`: stable programmatic code for a repeated condition.
- `message`: concise user-displayable failure text.
- `hint`: next action guidance for the agent.
- `detail`: structured payload such as validation failures, check output, or missing artifacts.
- `cause`: lower-level cause message when useful.
- `retryable`: whether rerunning the same step may succeed without edits.
- `risk`: risk context for destructive, permission, merge, or release operations.
- `permission_violations`: denied actions, paths, APIs, scopes, or identities.
- `missing_scopes`: auth scopes required to continue.
- `console_url`: URL for CI, cloud, approval, or admin consoles.
- `request_id`: upstream request identifier.
- `trace_id`: distributed trace identifier.

Agents should show `error.message`, add `error.hint` when present, route recovery from `error.type` and `error.subtype`, and include `error.code`, `error.console_url`, `error.request_id`, and `error.trace_id` in troubleshooting output. `permission_violations` and `missing_scopes` require explicit user or operator action; they should not be hidden inside prose.

`setup_update_required` and `setup_artifacts_missing` refer to the user-local deployment selected by the canonical project identity. Recovery is to rerun `hy-workflow setup` from the project; it does not require committing bootstrap files to the repository.
