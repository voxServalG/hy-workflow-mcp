# Evidence contract

Read this file on every eligible `hy-verify` run, before running `hy-workflow inspect --json`.

## Inspection is the floor

Run exactly `hy-workflow inspect --json` from the repository root. Its `hy-workflow.inspect.v1` envelope, not the Agent's recollection, is authoritative for:

- obligation IDs, statements, matched paths, scales, and source paths;
- exact `commandId`, `argv`, `expectedExitCode`, and associated obligation IDs;
- the `binding` fields `issuanceId`, `head`, `diffHash`, and `protocolHash`.

Do not remove an issued command, weaken an expected exit code, translate an argument array into a shell string, or manufacture a binding. If inspection returns `invalid` or `unavailable`, report its issues and continue with independently justified native checks.

## Execution and collection

1. Read every cited source before executing its command so the claimed invariant is understood.
2. Execute each issued `argv` directly from the repository root, preserving element order and boundaries. Do not invoke a shell unless the issued executable is itself the repository's native shell entry point.
3. Capture a canonical ISO-8601 UTC `startedAt` immediately before execution and `completedAt` immediately after it, plus the actual exit code, complete stdout, and complete stderr. Never convert a failing result into a pass.
4. Keep evidence in a temporary regular file outside Git. Do not add evidence, logs, caches, or private state to the repository.
5. Submit one result per issued `commandId`. Do not submit supplemental commands: the CLI correctly rejects commands it did not issue.
6. Run `hy-workflow verify --input-file <evidence.json> --json`. The equivalent `--input '<object>'` form is appropriate only when the complete JSON can be passed without lossy shell quoting.
7. Continue independent safe checks after one failure. If a fix changes the worktree, inspect again and rerun the commands issued for the new binding.

## Exact evidence shape

```json
{
  "schema": "hy-workflow.evidence.v1",
  "binding": {
    "issuanceId": "<inspect.binding.issuanceId>",
    "head": "<inspect.binding.head>",
    "diffHash": "<inspect.binding.diffHash>",
    "protocolHash": "<inspect.binding.protocolHash>"
  },
  "results": [
    {
      "commandId": "<inspect.commands[0].commandId>",
      "argv": ["<exact>", "<issued>", "<arguments>"],
      "startedAt": "2026-08-01T01:02:03.000Z",
      "completedAt": "2026-08-01T01:02:04.000Z",
      "exitCode": 0,
      "stdout": "<complete captured stdout>",
      "stderr": "<complete captured stderr>"
    }
  ]
}
```

Copy all four binding values and every `commandId` and `argv` from the same inspection. The CLI accepts no unknown fields, duplicate command IDs, unexpected commands, or changed argv. Each execution interval must be valid, canonical UTC and no longer than 24 hours.

## Freshness and result language

Evidence is current only while all four binding fields match a fresh inspection. A relevant change to `HEAD`, tracked content, untracked content, or root `hy-workflow.yml` changes the binding. Never reuse an old pass because the visible command text happens to match.

- `verified`: every issued command has exactly one current result and every exit code matches.
- `failed`: at least one current command result differs from its expected exit code.
- `missing`: at least one issued command has no submitted result.
- `stale`: submitted and current bindings differ.
- `invalid`: the evidence shape, command identity, argv, or other protocol fact is invalid.
- `unavailable`: current inspection cannot produce a verifiable binding.
- `unsigned`: a useful native check ran outside CLI issuance; this is an Agent label, not a CLI status.

Only `verified` supports a protocol-backed readiness claim. Unsigned passing checks remain useful but must be described as unsigned.

## Degradation behavior

- If the CLI is absent or incompatible, derive checks from repository instructions, manifests, and test configuration; run them and report unsigned results.
- If root `hy-workflow.yml` is absent or invalid, do not invent obligation matches. Run semantically appropriate native checks and report the index limitation.
- If a cited source or executable is missing, report the exact unavailable obligation and continue independent checks.
- If a command requires credentials, external services, destructive effects, or authority not supplied by the user, do not fake execution. Run all safe checks and name the remaining verification gap.
- Never ask the user to re-enter or unblock the workflow merely because evidence is incomplete. Ask only for a real permission, credential, task decision, or authorization required by the underlying action.
