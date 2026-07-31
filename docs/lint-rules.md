# Built-in Lint Rules

`hy-workflow lint --json` runs the first-party doclint and codelint engine shipped in the installed package. It is deterministic and offline: it does not download code, invoke a third-party linter or create/modify `codelint.json`, `doclint.json` or `docs-gardener.json`.

## Configuration authority

The lint engine reads the runtime configuration selected by the external project registration. Fresh helper registration derives a complete configuration from local project evidence and stores it outside the worktree. An existing valid external configuration remains byte-for-byte authoritative during migration.

Helper does not create a root `hy-workflow.json`, authority marker or GitHub Actions workflow. A historical tracked config is not selected merely because it exists. Preserved compatibility state and explicit `config` operations may provide the same schema-shaped values, but the current authority and absolute external path are reported by CLI/doctor rather than inferred from a project file.

Important selected values are:

- `project.codeExt`, `project.codeDirs`, `project.docsDir` and `project.baseBranch`;
- codelint scan roots and line thresholds;
- doclint line thresholds;
- policy profile, scoped overrides and time-bounded exceptions where supported.

Configured roots must be safe paths inside the project. Generated/dependency/runtime directories such as `.git`, `.hy`, `.codex`, `.opencode`, `node_modules`, `dist`, `build`, `coverage`, fixtures, examples, generated and vendor trees are excluded. Agent instruction files are not managed documentation.

## Policy precedence

The public profiles are `relaxed`, `standard` and `strict`. Effective configurable quality values resolve from profile, compatible legacy aliases, project rule, matching path overrides in declaration order, and active time-bounded exception. Later layers replace only fields they supply. Expired exceptions remain visible but do not alter results.

`off` disables a configurable quality finding; `advisory` and `warning` remain visible and exit zero; `error` blocks. Scan/parser integrity, safe paths, workflow scope, evidence freshness and project identity are not configurable quality findings and cannot be disabled through profiles or exceptions.

Policy explanation remains available through the config CLI, for example:

```bash
hy-workflow config --explain-policy code.max-lines --file test/example.ts --json
```

The result identifies the selected external authority and ordered contributing layers.

## Document checks

- `D001` scan integrity: the selected docs root is safe/readable and scans at least one supported document.
- `D002` reachability: an entry document exists and managed documents are reachable through local links.
- `D003` links: local targets/fragments exist and stay inside the documentation boundary without unsafe symlink traversal. External links are not fetched.
- `D004` structure: one meaningful H1, non-empty/non-jumping headings and closed fenced code blocks.
- `D005` size/content: empty shells fail; effective-line warning/error thresholds come from the selected config.

## Code checks

- `C001` scan integrity: selected extensions and scan roots are safe/readable and every configured supported extension scans real files.
- `C002` size/content: effective-line warning/error thresholds come from the selected config.
- `C005` parser/scanner integrity: supported-language scanning must complete deterministically; unsafe source structure, malformed scanner protocol or parser failure fails closed.

`C003` and `C004` remain schema-stable compatibility positions in the ten-check report, but they never execute dependency or module analysis. `C003` is always `not_configured`, `C004` is always `not_applicable`, and neither slot emits findings. A legacy `codelint.tiers` value and the retired `code.tier-dependency` or `code.dependency-cycle` policy keys may be read and preserved during migration, but the CLI ignores them. Skills must not present these slots as an architecture gate.

This is distinct from `boundary.no_new_external`, which checks whether a change introduces dependency-manifest differences. That workflow invariant does not infer module architecture.

## Applicability

Python uses packaged orchestration around the available standard-library parser/tokenizer. Rust uses the packaged deterministic lexical scanner. JavaScript/TypeScript and other language applicability is reported explicitly. An unsupported scanner is `not_applicable`, never a fabricated pass. A configured supported language that scans zero files fails.

## Report and exit status

The report schema is `hy-workflow.lint.v1`, version 1. It retains ten deterministic rule positions for compatibility, sorted findings and aggregate file/error/warning counts.

```json
{
  "schema": "hy-workflow.lint.v1",
  "version": 1,
  "ok": true,
  "root": "/project",
  "counts": {
    "checks": 10,
    "failed": 0,
    "errors": 0,
    "warnings": 0,
    "advisories": 0,
    "files": 12,
    "docs": 4,
    "code": 8
  },
  "checks": [
    {
      "rule": "D001",
      "status": "passed",
      "files": 4,
      "errors": 0,
      "warnings": 0,
      "message": "..."
    }
  ],
  "findings": []
}
```

Status is `passed`, `failed`, `warning`, `advisory`, `not_applicable` or `not_configured`. Warnings/advisories exit zero. Any error, invalid configuration, parser/scanner failure, configured zero scan, malformed report or runtime failure exits nonzero.

Teams may call this same command from their existing CI, but helper does not inject it. The repository remains responsible for runner/toolchain setup and required-check policy.
