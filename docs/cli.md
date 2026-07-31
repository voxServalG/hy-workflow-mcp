# CLI Contract

The public executable is `hy-workflow`, built from `src/main.ts` to `dist/main.js`. It is a normal process, not an MCP stdio server. Workflow, helper and `skills list` operations reserve stdout for one structured JSON document. `skills read` emits exact packaged Markdown by default and a structured document with `--json`. Exit code zero means success; exit code one means attention or failure.

## Top-level commands

```text
hy-workflow helper install|update|status|remove [options]
hy-workflow skills list|read [options]
hy-workflow setup [options]      # alias: helper install
hy-workflow unset [--json]       # alias: helper remove
hy-workflow <workflow-command> [--input <JSON>]
hy-workflow <workflow-command> --input-file <path>
hy-workflow lint --json
hy-workflow config ...
hy-workflow doctor ...
hy-workflow lint-contract
hy-workflow --version
```

The 15 workflow commands are `init`, `status`, `read-docs`, `plan`, `approve`, `branch`, `edit`, `sync-docs`, `verify`, `exam-plan`, `exam-submit`, `amend-plan`, `commit`, `merge`, and `reset`.

## Skill bundle inspection

`skills list` and `skills read` inspect content shipped with the running CLI package rather than an arbitrary project path.

```bash
hy-workflow skills list --json
hy-workflow skills read hy-status
hy-workflow skills read hy-verify SKILL.md --json
```

List output uses `hy-workflow.skills.v1` and includes the package version plus bundle and content hashes. Raw read output is byte-identical UTF-8 content; `--json` adds the same identity and hashes. Relative reference paths are allowed only inside a canonical bundled Skill and are rejected on traversal, backslash, directory or symbolic-link input.


Each workflow invocation accepts exactly one JSON object. Omitting both input flags means `{}`.

```bash
hy-workflow status
hy-workflow read-docs --input '{"stage":"before_plan","task":"fix retry recovery"}'
hy-workflow plan --input-file /tmp/hy-plan-input.json
hy-workflow approve --input '{"approved":"approve","decisionId":"plan:<issued-id>"}'
```

Rules:

- use either `--input` or `--input-file`, never both;
- either option may occur only once;
- input is limited to 1 MiB;
- an input file must be a regular file and not a symbolic link;
- the root value must be an object containing only fields allowed for that command;
- values must be finite, JSON-representable data;
- unknown commands, options and nested exam-result fields fail closed.

The CLI returns future calls as argv arrays. A Skill should execute that array directly through its process API, not join it into a shell string.

## Command inputs

| Command | Accepted input fields |
|---|---|
| `init`, `status`, `edit`, `sync-docs`, `verify`, `exam-plan`, `merge`, `reset` | none |
| `read-docs` | `stage`, `task`, `cursor` |
| `plan` | `task`, `plan` |
| `approve` | `approved`, `decisionId`, `note`, `auditDecision` |
| `branch` | `category`, `topic` |
| `exam-submit` | `examId`, `results` |
| `amend-plan` | `approved`, `decisionId`, `note` |
| `commit` | `title`, `body` |

`approved` follows the command-specific decision contract. Both decision commands require the exact `decisionId` signed into the current route; a missing or stale identity fails without changing state. `approve.auditDecision` accepts only `continue` or `replan`. Each exam result accepts only `id`, `command`, `nonce`, `exitCode`, optional `durationMs`, `stdoutTail`, and `stderrTail`.

PlanDoc shape is defined by the project schema and PlanDoc gate; a syntactically valid object is not necessarily a valid or complete plan.

## Helper grammar

```text
install [--clients all|codex,claude,opencode] [--mode auto|symlink|copy] [--json]
update  [--clients ...] [--mode ...] [--repair] [--json]
status  [--json]
remove  [--json]
```

On first install, omitted clients are selected from an existing deployment or positively detected Agent installations. If none are detected, the user must pass an exact client set. The comma-separated list contains no whitespace or duplicates.

Once installed, target set and projection preference are immutable. `update` accepts matching values for repeatability but rejects a change; use remove followed by install to choose a different set. `--repair` is update-only and restores intentionally missing owned projections. Helper output uses `hy-workflow.helper.v1` and always includes `projectFilesChanged: []`.

## Machine route contract

Workflow output uses `hy-workflow.cli.v1`. Its load-bearing fields are:

- `phase`, `stage`, `status` and `ok`;
- fact fields produced by the kernel;
- a structured `error` without prompt-like hints;
- `route.nextPhase`;
- `route.action.command`, `input`, `argv`, target phase/stage and `automatic`;
- `route.allowed` and `route.blocked`;
- `route.control` and structured `route.userAction`;
- optional structured `route.recovery` with a safe command and argv when available.

The adapter deliberately removes `display`, `summary`, top-level `hint`, human prompt/instruction strings and shell command strings. Those were transport-era presentation concerns. The active Skill renders a human explanation from facts and may not turn its own prose into CLI evidence.

## Dispatch and setup gate

Before a workflow handler runs, the CLI verifies external project deployment and configuration readiness. A missing or ambiguous identity returns a structured failure and a status route; it never falls back to a root file merely because that file exists. `init` cannot launch helper installation from inside the workflow.

## Support commands

`hy-workflow lint --json` runs offline first-party doclint and codelint. It does not create compatibility JSON and does not perform dependency-graph lint. For report-schema compatibility, it always emits `C003` as `not_configured` and `C004` as `not_applicable`; neither slot emits findings.

`config` inspects or changes the selected policy authority where supported. Except for explicit `--help`, it emits one compact `hy-workflow.config.v1` JSON envelope. Recovery actions contain exact `argv` elements and no presentation fields or joined shell command. `doctor` diagnoses external installation and ownership state. Neither changes the rule that helper fresh install writes no project files.

`lint-contract` is primarily for this package's maintainers. It checks that the shipped CLI/Skill/package contracts agree; consuming repositories normally use `lint` instead.
