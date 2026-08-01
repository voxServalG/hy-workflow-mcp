# Protocol example

Read this file before editing root `hy-workflow.yml` or creating incident and invariant source files. Follow the exact `hy-workflow.protocol.v1` shape below; confirm current limits and validation behavior with `hy-workflow inspect --json`.

## Minimal relation

```yaml
schema: hy-workflow.protocol.v1
obligations:
  - id: INV-HELPER-ZERO-PROJECT-WRITES
    kind: invariant
    status: active
    statement: Helper operations must not modify project files or Git metadata.
    sources:
      - docs/invariants/helper-zero-project-writes.md
      - docs/incidents/helper-overwrote-project-files.md
    applies_to:
      paths:
        - src/helper/**
        - package.json
        - package-lock.json
    verification:
      scale: large
      commands:
        - argv:
            - npm
            - run
            - test:helper-upgrade
          expected_exit_code: 0
```

The root relation index does not contain the incident narrative, test output, workflow phase, approval state, Agent instructions, or copied source documents. It tells the deterministic CLI which reviewed sources and native argv apply to a changed path.

Use IDs beginning with `INV-` for stable invariants and `INC-` for incident-specific obligations. Keep each matcher as narrow as the protected boundary permits. Use argv arrays, never shell command strings or environment assignments, and point to a repository-owned command rather than copying a long pipeline into YAML. Source paths must name regular Git-tracked files inside the repository.

## Source expectations

The incident source should answer:

```text
What failed and what was the impact?
How was the failure reproduced or observed?
What causal mechanism was demonstrated?
What repair removed that mechanism?
Which regression oracle fails before and passes after?
Which stable invariant follows from the event?
```

The invariant source should answer:

```text
What falsifiable property must remain true?
Which boundary does it protect?
Where does it apply and not apply?
Which incidents justify it?
Which project-native argv proves it for a matching diff?
```

Do not silently migrate, reorder, or rewrite unrelated obligations during one capture. If an old obligation is replaced, retain its ID with `status: superseded` and `superseded_by: <new-id>`; the successor must exist in the same protocol and supersession must not cycle.
