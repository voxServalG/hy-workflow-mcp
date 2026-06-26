# Error Contract

User-facing failures must use a structured error object. A string may be passed inside implementation helpers, but the tool boundary normalizes it before returning JSON to the MCP client.

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

## Shape

Each returned error has type, subtype, and message. Additional fields can carry stable details such as missingArtifacts, status, or check output. Agents should show error.message and use type/subtype for recovery decisions.

