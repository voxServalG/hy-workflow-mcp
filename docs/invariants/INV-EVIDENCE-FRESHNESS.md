# Evidence freshness invariant

A protocol-backed verification claim is valid only for the exact root protocol content, Git HEAD, staged state, unstaged state, non-ignored untracked content and modes, issued command identities, argv arrays, and expected exit codes from one stable inspection.

Any change to that binding makes prior evidence stale. Missing or failed results remain distinct from invalid input and unavailable inspection. The CLI reports Agent-attested structural evidence and does not claim independent execution provenance.

This rule protects `inspect`, `verify`, schemas, and the three Skills. It does not restrict supplemental native checks; they remain useful but unsigned unless a later inspection issues them.

Verification responsibility: protocol, inspect, evidence, and full thin-loop tests.
