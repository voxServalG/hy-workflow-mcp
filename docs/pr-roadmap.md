# CLI + Skill Migration and Release Roadmap

This roadmap tracks the current product transition as reviewable outcomes. It is not evidence that a gate has passed. A row is complete only when its implementation, focused tests, contract docs and recorded CI result agree.

The stable direction is defined by [Product Vision](./product-vision.md): one CLI owns state and evidence; 12 phase Skills own judgment and presentation; helper performs external-only installation and exact legacy retirement.

## Release-critical sequence

| Work package | Required outcome | Acceptance evidence |
|---|---|---|
| Public CLI shell | `dist/main.js` exposes 15 workflow commands, helper, lint/config/doctor; no server entrypoint starts. | Build, CLI unit tests, tarball entrypoint and no-server contract. |
| Prompt extraction and Skills | Exactly 12 cataloged Skills contain procedure/human communication and obey CLI phase/stage/allowed/exact argv. | Skill catalog parity, installed bundle hash, no removed transport/prose tokens. |
| Helper ownership | Atomic SSOT plus symlink/copy projections, immutable target set/mode, intentional-deletion preservation, repair and ownership-safe remove. | Unit/fault/concurrency/Windows lifecycle fixtures. |
| External project registration | Fresh install writes no project or Git file and returns `projectFilesChanged: []`. Existing external state is byte-preserved. | Fresh repository fingerprints and repeated-install convergence. |
| Legacy migration | Skills install before exactly owned `hy-workflow` MCP retirement; `docs-gardener`, unrelated config, worktree and current phase/scope survive. | `INC-UPGRADE-INJECTION-INTERFERENCE` installed-tarball oracle. |
| Project identity | Equivalent GitHub remote spellings share identity; ambiguous active canonical/legacy state fails closed. | Remote spelling and `PROJECT_IDENTITY_CONFLICT` fixtures. |
| Revived init | Local-only cognition covers docs, ecosystem, test platform and local Git/merge history without external access or project writes. | Offline multi-ecosystem cognition fixtures and worktree/`.git` fingerprints. |
| Verification recovery | Skills select semantic Small/Medium/Large; CLI grades complete evidence; successful re-verification supersedes stale commit recovery. | Synchronous/exam equivalence plus stale-recovery success/failure fixtures. |
| Public contracts | README/docs/AGENTS, command/Skill catalogs and contract lint describe the same CLI-only behavior. | Contract lint and Markdown/link/stale-token audit. |
| Installed-package acceptance | Baseline and five-repository pressure test the canonical tarball with zero skips. | `verify:dev`, Windows smoke, release pressure and SHA-512 continuity. |

## Promotion and stable publication

After every release-critical outcome is verified:

1. merge the migration PR to `dev` through its real checks;
2. compare `origin/main..origin/dev` and create/reuse a `dev` to `main` promotion PR;
3. wait for all required promotion checks and merge without adding unrelated commits;
4. create a stable GitHub Release whose tag equals `v` plus the package version;
5. let Trusted Publishing test and publish the one accepted tarball;
6. verify the workflow result and confirm npm `latest` points to that version;
7. install `latest` into an isolated previous-release fixture and repeat the seamless migration oracle.

The GitHub Release is not completion if npm publication or post-publication migration verification is missing.

## Post-stable follow-ups

These ideas are deliberately outside the transport migration unless a release blocker proves otherwise:

- richer status/dashboard facts without adding overlapping state authorities;
- generated command reference from catalog metadata;
- additional Agent targets after exact path/ownership semantics are researched;
- optional, documented CI recipes that teams adopt explicitly;
- dependency/module lint only after a useful cross-ecosystem model exists;
- further removal of internal compatibility fields after the CLI boundary has stable release evidence.

None of these follow-ups may reintroduce default repository injection, Agent-specific private state, hidden approval or a second transport authority.

## Incident rule

Every significant regression adds or strengthens an incident fixture before release. Prefer encoding the failure as a project invariant with a deterministic oracle. Add a new repository dimension only when the existing matrix cannot represent the behavior; do not grow the matrix merely to count repositories.
