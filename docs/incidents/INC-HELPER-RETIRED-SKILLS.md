# Helper retained obsolete Skills after bundle shrink

## Impact

The 0.5 update algorithm treated a Skill removed from a later bundle as retired but continued copying and projecting it. A release that merely reduced the catalog would therefore leave obsolete instructions active in Codex, Claude, and OpenCode, allowing removed stage behavior to keep matching user work.

## Reproduction and cause

Install the 0.5 bundle, then update with a package whose catalog omits a previously owned Skill. The update builds its desired set from the union of current bundle names and manifest names; for a missing bundle entry it copies the previous canonical directory and recreates every projection with `retired: true`. Manifest validation also assumes non-current entries are already retired, which prevents a naive catalog replacement before migration.

## Resolution

The 0.6 migration validates the complete legacy 12-Skill manifest under its original schema, preflights exact hashes and destinations, and transactionally replaces it with a 3-Skill manifest. The ten obsolete resources are removed only when ownership remains exact. Modified, foreign, or path-drifted resources cause a conflict and are preserved.

## Regression oracle

`npm run test:acceptance:migration` installs the public 0.5 package in an isolated home, updates it with the candidate tarball, and checks 12-to-3 projection, unrelated Skill preservation, and byte preservation of legacy project state.

## Derived invariant

[INV-HELPER-OWNERSHIP](../invariants/INV-HELPER-OWNERSHIP.md)
