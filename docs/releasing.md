# Releasing

Stable releases promote a reviewed development tree to `main`, create a GitHub Release whose tag is exactly `v<package version>`, and let `.github/workflows/npm-publish.yml` publish through npm Trusted Publishing.

The release workflow preserves one-byte-stream integrity:

1. Validate semantic version, prerelease state, tag checkout, and ancestry from `origin/main`.
2. Run the full local verification suite.
3. Build exactly one npm tarball and record its SHA-512 hash.
4. Run installed-package thin acceptance and the public 0.5-to-candidate Helper migration against that exact tarball.
5. Recompute SHA-512 and publish the same tarball as `latest` or `next` using GitHub OIDC. Publishing is the final side effect.

The workflow filename is part of the npm Trusted Publisher identity and must not be renamed casually. No npm token is stored. After publication, verify the GitHub Release, workflow conclusion, npm dist-tag, registry integrity and attestations, then perform a fresh registry install and a public 0.5-to-latest upgrade check.
