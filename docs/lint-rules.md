# Built-in lint rules

`hy-workflow lint --json` runs the first-party doclint and codelint engines shipped in the installed package. The command is deterministic and offline: it does not download code, invoke third-party lint packages, or create, modify, and restore `codelint.json`, `doclint.json`, or `docs-gardener.json`.

## Configuration

For a new deployment, setup creates the project-owned root `hy-workflow.json` and records an exact local authority marker. CI selects the same project-owned file through an exact versioned environment signal. The runtime validates the selected file with bundled, offline code; the `$schema` URL is editor metadata and is never fetched while a workflow runs.

An existing installation keeps working without a migration prompt or project edit. A valid external configuration remains authoritative. If there is no external configuration, hy-workflow detects the project read-only and uses frozen historical defaults. Unless the exact new authority marker or CI signal is present, runtime code does not read a root `hy-workflow.json` at all. Historical injected `AGENTS.md` blocks, workflows, `codelint.json`, `doclint.json`, and `docs-gardener.json` are ignored and do not need to be removed.

New configurations use:

```json
{
  "$schema": "https://raw.githubusercontent.com/voxServalG/hy-workflow-mcp/main/schemas/hy-workflow.schema.json",
  "version": 1,
  "project": {
    "baseBranch": "dev",
    "codeExt": [".ts"],
    "codeDirs": ["src"],
    "docsDir": "docs"
  },
  "codelint": {
    "lintDirs": ["src"],
    "maxLinesWarning": 300,
    "maxLinesError": 500,
    "tiers": [
      { "name": "domain", "paths": ["src/domain"] },
      { "name": "infra", "paths": ["src/infra"] }
    ]
  },
  "doclint": {
    "maxLinesWarning": 200,
    "maxLinesError": 500
  },
  "policy": {
    "profile": "standard",
    "rules": {
      "code.max-lines": { "warning": 400, "error": 700 }
    },
    "overrides": [
      {
        "files": ["test/**"],
        "rules": { "code.max-lines": { "severity": "advisory" } }
      }
    ],
    "exceptions": [
      {
        "rule": "docs.max-lines",
        "files": ["docs/legacy.md"],
        "reason": "Split is tracked separately",
        "owner": "docs-team",
        "issue": "#421",
        "expires": "2026-12-31"
      }
    ]
  }
}
```

`maxLines` remains a read-only legacy input and is interpreted as the error threshold. If it is present together with `maxLinesError`, both values must match. Warning thresholds must not exceed error thresholds. `codelint.tiers` is optional; its array is ordered from highest to lowest layer. Every tier name and normalized project-relative path must be unique, safe, and non-overlapping. A higher tier may depend on the same tier or a later lower tier; a lower tier must not depend on an earlier higher tier.

Generated and dependency directories such as `.git`, `.hy`, `.codex`, `.opencode`, `node_modules`, `dist`, `build`, `coverage`, fixtures, examples, generated, and vendor trees are excluded. Agent instruction files such as `AGENTS.md` and `CLAUDE.md` are not managed documentation. Configured roots must remain inside the project.

## Policy profiles and precedence

The public profiles are `relaxed`, `standard`, and `strict`. A profile is only a starting point. The effective value is resolved in this order: profile, legacy top-level `maxLines` aliases, project rule, matching path overrides in declaration order, then an active time-limited exception. Later layers replace fields supplied by earlier layers. Expired exceptions remain visible as diagnostics but do not change the result.

`off` disables a configurable quality finding. `advisory` keeps it visible without failing the command. `warning` stays visible and exits zero. `error` blocks. Exceptions require a rule, files, reason, owner, and expiry date; an issue reference is recommended.

Scan integrity, parser integrity, path and scope boundaries, evidence freshness, and project identity are safety invariants. Profiles, overrides, and exceptions cannot disable or weaken them.

To see exactly why a rule has its current value, run:

```sh
hy-workflow config --explain-policy code.max-lines --file test/example.ts --json
```

The result includes the selected configuration authority, ordered source layers, effective values, and diagnostics.

## Document rules

- `D001` scan integrity: `project.docsDir` must be a safe in-repository directory and contain at least one `.md` or `.mdx` document.
- `D002` reachability: the docs root needs an `index.md`, `index.mdx`, `README.md`, or `README.mdx` entry point, and every managed document must be reachable through local document links.
- `D003` links: non-external local targets must exist, remain in the docs boundary, and not traverse symlinks. Markdown fragments match GitHub-style duplicate slugs or explicit ids. External links and links inside code fences are not fetched.
- `D004` structure: a non-empty document starts with exactly one H1, headings are non-empty and do not jump levels, and fenced code blocks close.
- `D005` size: documents must contain effective content; effective lines above 200 warn by default and above 500 fail by default.

## Code rules

- `C001` scan integrity: `project.codeExt` and `codelint.lintDirs` must select readable files; every configured extension must scan at least one file.
- `C002` size: effective code lines above 300 warn by default; above 500 fail by default.
- `C003` dependency tiers: configured tier paths must be valid and lower layers must not import earlier higher layers. The check is `not_configured` when tiers are absent.
- `C004` cycles: supported Python, Rust, JavaScript, and TypeScript local dependency graphs must not contain a multi-file strongly connected component. The check is `not_applicable` when the selected language has no dependency scanner.
- `C005` parser integrity: sources must be read, Python AST/tokenize subprocess results must satisfy their protocol, and Rust/JavaScript lexical parsing must complete. Syntax or lexical errors, scanner omissions, and unsafe source structure fail closed. Unsupported languages are reported as `not_applicable`, not as a pass.

Python uses the standard-library AST/tokenize scanner available on the runner. Rust uses the packaged deterministic tokenizer and module/import parser; neither scanner requires a third-party runtime package.

## Report and exit status

The JSON report has schema `hy-workflow.lint.v1` and contains exactly ten ordered checks plus sorted findings:

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
    { "rule": "D001", "status": "passed", "files": 4, "errors": 0, "warnings": 0, "message": "..." }
  ],
  "findings": []
}
```

Check status is one of `passed`, `failed`, `warning`, `advisory`, `not_applicable`, or `not_configured`. Warnings and advisories remain visible but exit zero. Any error, invalid configuration, parser failure, configured-language zero scan, malformed report, or runtime failure exits nonzero. CI additionally requires at least one scanned documentation file and rejects a report whose `ok` is false or whose error count is nonzero.
