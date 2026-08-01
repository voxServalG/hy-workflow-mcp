# Helper reported a partial three-Skill projection as healthy

## Impact

After the 0.6.0 three-Skill bundle was installed, Codex could expose only `hy-capture` while `hy-init` and `hy-verify` were absent. `helper status` still reported healthy and `helper update` reported unchanged, so users could not restore the advertised cross-Agent bundle through the normal lifecycle command.

## Reproduction and cause

In a valid schema-v2 ownership manifest, mark the Codex projections for `hy-init` and `hy-verify` as intentionally deleted and remove those two directories. The status implementation treats the missing paths as expected, and the update implementation carries the deletion flags forward. Earlier update behavior also converted any missing owned projection into this persistent deletion state. The manifest therefore turned accidental drift into desired state.

## Resolution

Every Skill present in the packaged v2 catalog is now explicit desired state. Status reports a deletion marker on a current Skill or projection as drift. A normal update transaction restores missing current catalog projections and rewrites their deletion markers to false. Exact ownership preflight still rejects modified resources and preserves foreign Skills.

## Regression oracle

`npm run test:unit` includes `helper-projection-recovery.ts`, which constructs the faulty schema-v2 state, requires status to report attention, runs ordinary update without a repair flag, and checks that Codex again contains exactly `hy-init`, `hy-verify`, and `hy-capture` with healthy ownership facts.

## Derived invariant

[INV-HELPER-OWNERSHIP](../invariants/INV-HELPER-OWNERSHIP.md)
