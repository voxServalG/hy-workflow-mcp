# Output Contract

Every user-facing tool response is a JSON envelope. Legacy fields can remain, but the agent control plane is stable and documented here.

## Required Envelope Fields

- ok
- phase
- next
- display
- hint
- requires_user
- stop_here
- allowedTools
- blockedTools
- recovery

## Error Envelope

Failures return error with type, subtype, and message. The subtype must exist in docs/errors.md and src/errors/catalog.ts. The server catch block must not return a bare string error.

## Result Envelope

Successful tools return ok true, phase, next, and any tool-specific data. Tools that require a human decision set requires_user and stop_here. Tools that can continue automatically omit stop_here unless an API, CI, merge, or recovery condition blocks the workflow.

