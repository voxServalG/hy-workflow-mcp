# hy-workflow

hy-workflow is a free, Git-native, cross-Agent thin protocol that relates reviewed historical incidents and project invariants to applicable code and project-native verification commands, then issues and checks Agent-attested evidence for the current diff.

It is deliberately not a planner, Agent, test runner, continuous-integration service, code reviewer, retrieval system, or workflow state machine.

## Install

```bash
npm install --global @voxstudio/hy-workflow
hy-workflow helper install --json
```

Restart Codex, Claude Code, or OpenCode after the first install. Helper detects installed hosts and projects exactly three user-level Skills: `hy-init`, `hy-verify`, and `hy-capture`. It does not modify the current repository, Git, MCP configuration, Agent project configuration, or GitHub Actions.

Use `helper update`, `helper status`, and `helper remove` for later lifecycle operations. All Helper output uses the stable `hy-workflow.helper.v2` envelope.

## Project protocol

Projects opt in through ordinary reviewed Git files. Human meaning stays in Markdown and native tests; the root YAML file is only a relation index:

```text
docs/incidents/INC-...md
docs/invariants/INV-...md
test/... project-native regression test
hy-workflow.yml
```

```yaml
schema: hy-workflow.protocol.v1
obligations:
  - id: INV-PARSER-LENGTH
    kind: invariant
    status: active
    statement: Every decoded record contains all bytes declared by its header.
    sources:
      - docs/incidents/INC-PARSER-TRUNCATION.md
      - docs/invariants/INV-PARSER-LENGTH.md
    applies_to:
      paths:
        - src/parser/**
    verification:
      scale: small
      commands:
        - argv: ["npm", "run", "test:parser-regression"]
          expected_exit_code: 0
```

The schema rejects unknown fields, duplicate IDs, unsafe paths, YAML aliases, untracked sources, shell command strings, and invalid supersession. Helper never creates or injects this file.

## Inspect and verify

After a change:

```bash
hy-workflow inspect --json
```

`inspect` snapshots HEAD plus tracked, staged, unstaged, renamed, deleted, and non-ignored untracked content. It returns matching obligations, deduplicated exact argv, and a deterministic binding. The Agent reads the cited sources and executes every issued argv directly from the repository root.

Submit one result per issued command using [the evidence schema](schemas/hy-workflow.evidence.schema.json):

```bash
hy-workflow verify --input-file /tmp/hy-evidence.json --json
```

`verify` distinguishes `verified`, `failed`, `missing`, `stale`, `invalid`, and `unavailable`. Any change to the protocol, HEAD, index, worktree, untracked content, command, or expected exit code invalidates old evidence. Evidence is labeled `agent_attested`: the CLI verifies structural binding and truthful consistency of the submitted facts, not independent cryptographic execution provenance.

CLI status is never an Agent permission gate. An unavailable protocol prevents only a protocol-backed readiness claim; the Agent continues safe diagnosis, editing, and repository-native checks without asking the user to repair internal workflow state.

## Skills

- `hy-init` builds a bounded, read-only task-local map from local Git evidence and only applicable knowledge sources.
- `hy-verify` treats CLI matches as a minimum, adds semantic Small/Medium/Large checks when boundaries require them, executes exact argv, and explains gaps.
- `hy-capture` turns only a demonstrated major incident into an incident source, falsifiable invariant, native regression oracle, and narrow relation entry for normal Git review.

Detailed storage, matching, trust, migration, and release behavior starts at [docs/index.md](docs/index.md).

## Development

```bash
npm ci
npm run verify
npm run test:acceptance:thin
```

The networked public 0.5 upgrade oracle is `npm run test:acceptance:migration`. Generated `dist` and `.tgz` artifacts are never committed.

License: MIT.
