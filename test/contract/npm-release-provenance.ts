import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function extractValidator(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  const startMarker = "          node --input-type=module <<'NODE'\n";
  const start = normalized.indexOf(startMarker);
  const end = normalized.indexOf("\n          NODE", start + startMarker.length);
  assert(start >= 0 && end > start, "release provenance Node validator is missing");
  return normalized
    .slice(start + startMarker.length, end)
    .split("\n")
    .map(line => line.startsWith("          ") ? line.slice(10) : line)
    .join("\n");
}

const rawWorkflow = readFileSync(".github/workflows/npm-publish.yml", "utf8");
const workflow = rawWorkflow.replace(/\r\n?/g, "\n");
const validator = extractValidator(rawWorkflow);
assert(extractValidator(workflow.replace(/\n/g, "\r\n")) === validator, "release provenance validator must parse identically with CRLF");

function validate(version: string, tag: string, prerelease: boolean, expected: boolean): void {
  const root = mkdtempSync(join(tmpdir(), "hy-release-provenance-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }) + "\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", validator], {
    cwd: root,
    env: { ...process.env, RELEASE_TAG: tag, IS_PRERELEASE: String(prerelease) },
    encoding: "utf8",
  });
  assert((result.status === 0) === expected, `${version}/${tag}/prerelease=${prerelease} returned ${result.status}: ${result.stderr}`);
}

validate("1.2.3", "v1.2.3", false, true);
validate("1.2.3-next.0", "v1.2.3-next.0", true, true);
validate("1.2.3-next.0", "v1.2.3-next.0", false, false);
validate("1.2.3", "v1.2.3", true, false);
validate("1.2.3", "v1.2.4", false, false);
validate("not-semver", "vnot-semver", false, false);

for (const token of [
  "fetch-depth: 0",
  'test "$tag_commit" = "$head_commit"',
  "refs/remotes/origin/main",
  "git merge-base --is-ancestor",
  "Build one release tarball",
  'npm run test:acceptance -- --package-archive "$HY_RELEASE_TGZ"',
  'test "$actual_sha512" = "$HY_RELEASE_TGZ_SHA512"',
  'npm publish "$HY_RELEASE_TGZ" --access public --tag next',
  'npm publish "$HY_RELEASE_TGZ" --access public --tag latest',
]) {
  assert(workflow.includes(token), `release provenance workflow token is missing: ${token}`);
}
assert(workflow.indexOf("Validate release provenance") < workflow.indexOf("npm run verify"), "release provenance must run before verification");
assert(workflow.indexOf("Build one release tarball") < workflow.indexOf("--package-archive"), "the canonical tarball must exist before acceptance consumes it");
assert(workflow.indexOf("--package-archive") < workflow.indexOf('npm publish "$HY_RELEASE_TGZ"'), "acceptance must gate publication of the same tarball");
for (const forbidden of ["actions/upload-artifact", "gh release upload", "NPM_TOKEN", "NODE_AUTH_TOKEN"]) {
  assert(!workflow.includes(forbidden), `release workflow must not contain ${forbidden}`);
}

console.log("npm-release-provenance: tag, branch ancestry, prerelease channel, and no-upload contract passes");
