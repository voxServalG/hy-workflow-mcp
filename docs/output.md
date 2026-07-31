# Output Contract

The CLI emits facts and executable routes. Human-facing prose belongs to the active Skill, not the transport boundary. Workflow and helper operations each write exactly one JSON document followed by a newline.

## Workflow envelope

Schema: `hy-workflow.cli.v1`, version `1`.

```json
{
  "schema": "hy-workflow.cli.v1",
  "version": 1,
  "command": "status",
  "ok": true,
  "phase": "plan",
  "stage": "plan.before_plan",
  "status": "ready",
  "route": {
    "nextPhase": "plan",
    "action": {
      "command": "read-docs",
      "argv": null,
      "input": { "stage": "before_plan" },
      "inputRequired": [
        {
          "path": "task",
          "type": "string",
          "source": "current_user_task",
          "minLength": 1
        }
      ],
      "phase": "plan",
      "stage": "plan.before_plan",
      "automatic": false
    },
    "allowed": ["read-docs", "status"],
    "blocked": ["branch", "commit", "merge"],
    "control": {
      "automatic": false,
      "stop": true,
      "reason": "information_required"
    },
    "userAction": {
      "kind": "provide_information"
    }
  }
}
```

The exact fact fields between the position fields and `route` depend on the command. Examples include `plan`, `cognition`, `checks`, `implementationManifest`, `prNumber`, `data` and documentation metadata. A Skill must distinguish those CLI facts from its own interpretation.

### Stable position fields

- `schema` and `version` select the parser contract.
- `command` is the command just dispatched, or `null` when parsing failed before a command was selected.
- `ok` controls the process exit code.
- `phase`, `stage` and `status` describe the persisted workflow position after the operation.
- `error`, when present, is structured and never hidden in human prose.

### Route fields

- `nextPhase` is the phase-level compatibility target.
- `action.command` is a public CLI command, or `null` when the next step is external or informational.
- `action.target` identifies an external/non-workflow target when applicable.
- `action.argv` is the exact safe argv array, or `null` when no CLI call is ready.
- `action.input` repeats the structured input when one exists.
- `action.inputRequired` declares only the missing fields for a known command. Each item gives a JSON `path`, value `type`, trusted `source`, and optional `minLength`, `options` or `decisionId`. For approval routes, the signed decision identity is already fixed in `action.input.decisionId` and must be preserved unchanged.
- `action.phase`, `action.stage` and `action.automatic` bind the action to its intended position.
- `allowed` and `blocked` are public command names after compatibility mapping.
- `choices` is present only when the Skill must select among explicitly issued commands, such as bounded synchronous `verify` versus asynchronous `exam-plan`.
- `control.stop` is the decisive stop boundary. `control.reason` explains the class of stop.
- `userAction` contains structured decision or information facts with no prompt/instruction text.
- `recovery` contains a strategy and, when safe, a mapped command plus exact argv.

The CLI deliberately excludes legacy `display`, `summary`, top-level `hint`, user prompt/instruction strings, recovery instruction strings and shell command strings. Skills render explanations from structured facts and their versioned procedures.

When `argv` is non-null, the Skill preserves every argument boundary and executes it unchanged after any structured stop condition is satisfied. When `argv` is null but `command` is non-null, only that command's Skill may fill the declared `inputRequired` fields from their named sources, merge them with the signed partial `input` without overwriting it, and construct one argv array. When both are null, the Skill may process only explicit `choices`, an external target, recovery, or a true terminal result; it must never pick a command from `allowed` or infer one from phase/stage prose.

## Failure envelope

Parsing, setup-gate and handler failures use the same schema. A failure keeps the best known current phase/stage, reports `status: "failed"`, includes `error`, and normally routes to `status` as the only safe command.

```json
{
  "schema": "hy-workflow.cli.v1",
  "version": 1,
  "command": "plan",
  "ok": false,
  "phase": "plan",
  "stage": "plan.compose",
  "status": "failed",
  "error": {
    "type": "validation",
    "subtype": "invalid_arguments",
    "code": "INPUT_UNKNOWN_FIELDS",
    "message": "plan does not accept input fields: extra.",
    "retryable": false
  },
  "route": {
    "nextPhase": "plan",
    "action": {
      "command": "status",
      "argv": ["hy-workflow", "status"],
      "phase": "plan",
      "stage": "plan.compose",
      "automatic": false
    },
    "allowed": ["status"],
    "blocked": [],
    "control": {
      "automatic": false,
      "stop": true,
      "reason": "repair_required"
    },
    "userAction": null
  }
}
```

## Helper envelope

Schema: `hy-workflow.helper.v1`, version `1`.

```json
{
  "schema": "hy-workflow.helper.v1",
  "version": 1,
  "command": "install",
  "ok": true,
  "status": "completed",
  "projectRoot": "/project",
  "clients": ["codex", "opencode"],
  "layers": {
    "skills": { "status": "installed", "skillCount": 12 },
    "project": { "status": "registered", "projectFilesChanged": [] },
    "mcp": { "status": "retired", "remainingOwnedClients": [] }
  },
  "projectFilesChanged": []
}
```

Top-level helper status is `completed`, `attention`, `partial` or `failed`. Partial results preserve the truth of each layer and include a recovery object with exact argv and completed layers. `projectFilesChanged` is always an empty array.

## Skill bundle envelope

Schema: `hy-workflow.skills.v1`, version `1`.

```json
{
  "schema": "hy-workflow.skills.v1",
  "version": 1,
  "ok": true,
  "package": { "name": "@voxstudio/hy-workflow", "version": "<semver>", "bundleHash": "<sha256>" },
  "count": 12,
  "skills": [{ "name": "hy-status", "path": "skills/hy-status/SKILL.md", "contentHash": "<sha256>" }]
}
```

`skills list --json` identifies the exact running package and every canonical Skill. `skills read <name> [relative-path] --json` binds the selected file to the same package and bundle hash. A raw `skills read` is the deliberate non-JSON exception: it writes the packaged UTF-8 bytes unchanged so an Agent can load the authoritative Skill text directly.

Skill command failures use the same schema with `ok: false` and a stable `error.code`. Relative reads reject absolute paths, backslashes, traversal, directories, symlinks and files outside the selected Skill.

## Config envelope

Schema: `hy-workflow.config.v1`, version `1`.

```json
{
  "schema": "hy-workflow.config.v1",
  "version": 1,
  "command": "check",
  "ok": false,
  "status": "attention",
  "issues": ["hy-workflow.json project.docsDir is required"],
  "recovery": {
    "strategy": "external_action",
    "tool": "terminal",
    "argv": ["hy-workflow", "config", "--apply", "--json", "--docs-dir", "existing-docs-dir"]
  }
}
```

Every config operation except explicit `--help` emits one compact JSON envelope; `--json` remains accepted for command compatibility. Check and apply results expose detected project facts, issues, drift, suggestions and write outcomes. Policy explanations use the same schema with `command: "explain-policy"`.

The envelope never exposes `display`, top-level or nested `hint`, model-facing instructions, or a joined recovery command. A recovery action is inert structured data whose `argv` elements must be passed to a shell-free process API without joining or reparsing them.

## Process behavior

- Exit `0`: envelope `ok` is true.
- Exit `1`: envelope needs attention or failed.
- JSON goes to stdout as one line for reliable Agent parsing.
- Unexpected top-level process exceptions go to stderr and exit one; ordinary command errors remain structured JSON.
- A consumer must select behavior from schema/version and fields, never scrape natural-language `message` text.
