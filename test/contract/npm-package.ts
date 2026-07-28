import { readPackageJson, npmPackDryRun, parseNpmPackEntries, parseNpmPackFiles } from "../../src/npm/package.js";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const pkg = readPackageJson(process.cwd());

const expectedFixtureFiles = ["dist/server.js", "templates/hy-workflow.yml"];
const npm10FixtureFiles = parseNpmPackFiles([{ files: expectedFixtureFiles.map(path => ({ path })) }]);
const npm12FixtureFiles = parseNpmPackFiles({
  "@voxstudio/hy-workflow": { files: expectedFixtureFiles.map(path => ({ path })) },
});
const malformedFixtureFiles = parseNpmPackFiles({
  "@voxstudio/hy-workflow": { files: [{ path: "dist/server.js" }, { path: "" }, {}, "invalid"] },
  metadata: null,
});
assert(npm10FixtureFiles.join(",") === expectedFixtureFiles.join(","), "npm 10 array-shaped pack JSON must be parsed");
assert(npm12FixtureFiles.join(",") === expectedFixtureFiles.join(","), "npm 12 package-keyed pack JSON must be parsed");
assert(malformedFixtureFiles.join(",") === "dist/server.js", "malformed pack entries must be ignored");
assert(parseNpmPackEntries([{ filename: "fixture.tgz" }])[0]?.filename === "fixture.tgz", "pack metadata entries must be preserved");

assert(pkg.name === "@voxstudio/hy-workflow", "package.json name must be @voxstudio/hy-workflow");
assert(pkg.publishConfig?.access === "public", "scoped package must publish with public access");
assert(typeof pkg.repository !== "string" && pkg.repository?.url === "git+https://github.com/voxServalG/hy-workflow-mcp.git", "repository URL must match the public GitHub source");
assert(pkg.engines?.node === ">=18", "package must declare Node.js >=18");

// bin and main point at dist/server.js
assert(pkg.main === "dist/server.js", "package.json main must be dist/server.js");
assert(pkg.bin?.["hy-workflow"] === "dist/server.js", "hy-workflow bin must point at dist/server.js");
const serverPath = join(process.cwd(), "dist", "server.js");
const nonGitDirectory = mkdtempSync(join(tmpdir(), "hy-version-"));
assert(execFileSync(process.execPath, [serverPath, "--version"], { cwd: nonGitDirectory, encoding: "utf8" }).trim() === pkg.version, "CLI --version must work outside a Git project and match package.json");
assert(execSync("node dist/server.js --help", { cwd: process.cwd(), encoding: "utf8" }).includes("hy-workflow setup"), "CLI help must expose the bundled setup command");
assert(execSync("node dist/server.js --help", { cwd: process.cwd(), encoding: "utf8" }).includes("hy-workflow lint --json"), "CLI help must expose the built-in lint command");

// publishing builds dist, but installing the registry package never compiles locally
assert(pkg.scripts?.clean === "node scripts/clean-dist.mjs", "clean must use the cross-platform Node dist cleaner");
assert(pkg.scripts?.build === "npm run clean && tsc", "every build must start from an empty dist directory");
assert(pkg.scripts?.prepack === "npm run build", "prepack must clean and build the npm-only dist directory");
assert(pkg.scripts?.prepublishOnly === "npm run verify", "prepublishOnly must run the full verification suite");
for (const lifecycle of ["prepare", "install", "postinstall"]) {
  assert(pkg.scripts?.[lifecycle] === undefined, `${lifecycle} must not build during npm install`);
}

// files include compiled runtime, docs, shared templates, and README; platform scripts are gone
const requiredFiles = ["dist", "docs", "templates", "AGENTS.md", "README.md"];
for (const file of requiredFiles) {
  assert(pkg.files?.includes(file) === true, `package.json files must include ${file}`);
}

// required npm scripts
const requiredScripts = ["clean", "build", "lint", "lint:contract", "test", "test:unit", "test:e2e", "test:contract", "test:acceptance", "test:windows", "verify"];
for (const script of requiredScripts) {
  assert(typeof pkg.scripts?.[script] === "string", `Missing required npm script: ${script}`);
}
const windowsSmoke = readFileSync("scripts/windows-smoke.mjs", "utf8");
for (const token of ["npm pack", "@voxstudio/docs-gardener@1.0.0-next.0", "installed lint", "installed setup", "repeated installed setup", "installed unset", "projectFilesChanged", "codelint.json"]) {
  assert(windowsSmoke.includes(token), `Windows smoke is missing installed-package lifecycle evidence: ${token}`);
}
assert(windowsSmoke.includes("process.env.npm_execpath") && windowsSmoke.includes("const npmCommand = process.execPath") && windowsSmoke.includes("npmCommandPrefix"), "Windows smoke must invoke npm-cli.js through the native Node executable and structured argv");
assert(!windowsSmoke.includes('"npm.cmd"'), "Windows smoke must not pass npm.cmd to the shell-free structured supervisor");

// dist must not be tracked by git
const tracked = execSync("git ls-files", { cwd: process.cwd(), encoding: "utf-8", stdio: ["pipe","pipe","pipe"] }).trim().split("\n").filter(Boolean);
const trackedDist = tracked.filter((f: string) => f.startsWith("dist/"));
assert(trackedDist.length === 0, `dist files must not be tracked by git, found ${trackedDist.length}: ${trackedDist.slice(0, 3).join(", ")}`);

// npm pack dry-run must exclude source, test, and local artifacts
const forbidden = [".hy/", ".opencode/", ".codex/", "test/", "src/", "codelint.json", "doclint.json", "docs-gardener.json"];
const packFiles = npmPackDryRun(process.cwd());
assert(packFiles.includes("dist/server.js"), "npm pack must include the compiled CLI entrypoint");
assert(packFiles.includes("templates/hy-workflow.yml"), "npm pack must include the default setup workflow template");
for (const module of ["code.mjs", "docs.mjs", "fs.mjs", "index.mjs", "markdown.mjs", "python.mjs", "rust.mjs"]) {
  assert(packFiles.includes(`templates/lint/${module}`), `npm pack must include templates/lint/${module}`);
}
assert(packFiles.includes("AGENTS.md"), "npm pack must include the canonical managed-rules migration source");
const lintReport = JSON.parse(execFileSync(process.execPath, [serverPath, "lint", "--json"], { cwd: process.cwd(), encoding: "utf8" }));
assert(lintReport.schema === "hy-workflow.lint.v1" && lintReport.counts?.checks === 10 && lintReport.counts?.errors === 0, "packed CLI entrypoint must execute the built-in ten-rule lint report");
const managedRules = execFileSync(process.execPath, [serverPath, "config", "--print-managed-rules"], { cwd: nonGitDirectory, encoding: "utf8" });
assert(managedRules.startsWith("<!-- hy-workflow-rules -->") && managedRules.includes("hy-workflow-rules-version:"), "installed CLI must print a complete versioned managed-rules block outside a Git project");
assert(!packFiles.includes("setup") && !packFiles.includes("setup.ps1"), "npm pack must not include removed platform installers");
for (const file of packFiles) {
  for (const prefix of forbidden) {
    assert(!file.startsWith(prefix), `npm pack must not include ${file}`);
  }
}

// publishing uses npm trusted publishing; GitHub never stores the compiled output
const workflow = readFileSync(".github/workflows/npm-publish.yml", "utf8");
assert(workflow.includes("id-token: write"), "npm publish workflow must request an OIDC id-token");
assert(workflow.includes("fetch-depth: 0"), "npm publish workflow must fetch complete history for release ancestry validation");
assert(workflow.includes("npm@11.13.0"), "npm publish workflow must pin its OIDC-capable npm CLI");
for (const token of [
  "Validate release provenance",
  "release tag must equal v",
  "package semver prerelease state must match GitHub release.prerelease",
  "git merge-base --is-ancestor",
  "refs/remotes/origin/main",
  'test "$tag_commit" = "$head_commit"',
]) {
  assert(workflow.includes(token), `npm publish workflow must enforce release provenance token: ${token}`);
}
assert(workflow.indexOf("Validate release provenance") < workflow.indexOf("npm run verify"), "release provenance must be validated before expensive verification");
assert(workflow.includes("Build one release tarball"), "release workflow must build one canonical tarball");
assert(workflow.includes("Checkout pinned Vite acceptance mirror") && workflow.includes("Checkout pinned Flask acceptance mirror") && workflow.includes("Checkout pinned Express acceptance mirror"), "release workflow must materialize pinned public acceptance mirrors");
assert((workflow.match(/persist-credentials: false/g) ?? []).length >= 6, "release checkouts must never persist GitHub credentials");
assert(workflow.includes('npm run test:acceptance -- --package-archive "$HY_RELEASE_TGZ"'), "release acceptance must consume the canonical tarball path");
assert(workflow.indexOf("--package-archive") < workflow.indexOf('npm publish "$HY_RELEASE_TGZ"'), "release acceptance must gate publication of the same tarball");
assert(workflow.includes('test "$actual_sha512" = "$HY_RELEASE_TGZ_SHA512"'), "publish must reject a tarball changed after acceptance");
assert(workflow.includes('npm publish "$HY_RELEASE_TGZ" --access public --tag next'), "prereleases must publish the accepted tarball with the next tag");
assert(workflow.includes('npm publish "$HY_RELEASE_TGZ" --access public --tag latest'), "stable releases must publish the accepted tarball with the latest tag");
assert((workflow.match(/npm pack --json --pack-destination/g) ?? []).length === 1, "release workflow must create exactly one canonical tarball");
for (const forbiddenToken of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "upload-artifact", "gh release upload", "actions/attest-build-provenance"]) {
  assert(!workflow.includes(forbiddenToken), `npm publish workflow must not contain ${forbiddenToken}`);
}

const matrix = JSON.parse(readFileSync("test/acceptance/matrix.json", "utf8"));
assert(matrix.repositories.length === 5, "release acceptance must run all five pinned public mirrors");
assert(matrix.repositories.every((repo: any) => repo.url.startsWith("https://") && /^[0-9a-f]{40}$/.test(repo.commit)), "acceptance repositories must use HTTPS and full immutable commits");
assert(new Set(matrix.repositories.map((repo: any) => repo.id)).size === 5, "acceptance repository ids must be unique");
const legacyRepositories = matrix.repositories.filter((repo: any) => repo.category === "legacy");
assert(legacyRepositories.length === 0, "private legacy mirrors are no longer part of release acceptance");
assert(matrix.repositories.every((repo: any) => /^HY_ACCEPTANCE_[A-Z0-9_]+_MIRROR$/.test(repo.mirrorEnv)), "every pinned repository must support an explicit local acceptance mirror");
assert(new Set(matrix.repositories.map((repo: any) => repo.mirrorEnv)).size === 5, "acceptance mirror environment inputs must be unique");
for (const repo of matrix.repositories) {
  const slug = repo.url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  assert(workflow.includes(`repository: ${slug}`) && workflow.includes(`ref: ${repo.commit}`) && workflow.includes(`${repo.mirrorEnv}:`), `release workflow must materialize and bind the pinned mirror for ${repo.id}`);
}
assert(matrix.repositories.find((repo: any) => repo.id === "flask")?.expected?.docsDir === ".", "RST-only Flask docs must use its root README.md instead of an empty doclint directory");
const runner = readFileSync("test/acceptance/runner.ts", "utf8");
const harness = readFileSync("test/acceptance/harness.ts", "utf8");
const scenarios = readFileSync("test/acceptance/scenarios.ts", "utf8");
const failpointChild = readFileSync("test/acceptance/setup-failpoint-child.mjs", "utf8");
assert(runner.includes("skipped: []") && runner.includes("expectedScenarios"), "release acceptance must forbid skips");
assert(runner.includes('process.argv.indexOf("--package-archive")') && runner.includes("packAndInstall(workspace, matrix.companionPackage, packageArchive)"), "acceptance runner must accept and consume an explicit release tarball");
assert(runner.includes("abortAcceptance(error)") && runner.includes("await mainPromise"), "acceptance total timeout must abort future work and await main settlement before reporting");
assert(harness.includes('run("npm", ["pack"') && harness.includes('"install", "--global", archive, companionPackage'), "acceptance must test the locally packed distribution with the exact companion package");
assert(harness.includes("const installAttempts = 2") && harness.includes('"--fetch-timeout=60000"') && harness.includes("isolated npm package installation failed"), "acceptance must use bounded retries for the exact registry companion package");
assert(harness.includes("assertAcceptanceActive()") && harness.includes('spawn("taskkill", ["/PID"'), "acceptance must reject post-timeout spawns and terminate Windows process trees");
assert(harness.includes("pathToFileURL") && harness.includes('run("git", ["cat-file", "-e"') && harness.includes("repo.mirrorEnv"), "acceptance mirrors must be local directories pinned to the contracted commit and fetched through file URLs");
assert(harness.includes("GIT_TERMINAL_PROMPT") && harness.includes("CODEX_HOME"), "acceptance must isolate credentials and client state");
assert(harness.includes("npm_config_userconfig") && harness.includes("SSH_AUTH_SOCK") && harness.includes("NPM_TOKEN"), "acceptance must use an empty isolated npm config and reject inherited credentials");
assert(harness.includes('"/usr/bin:/bin:/usr/local/bin"'), "Linux acceptance must prefer the OS runtime toolchain over mutable /usr/local overrides");
assert(harness.includes("message.result?.isError") && harness.includes("substantive document facts"), "acceptance must reject MCP error/empty documentation responses");
assert(scenarios.includes("isolatedUserStateFingerprint") && scenarios.includes("failpoint left isolated HOME or client state changes"), "every transaction failpoint must restore isolated user state exactly");
assert(scenarios.includes('"SETUP_LOCK_BUSY"') && scenarios.includes("retryableContention") && scenarios.includes("postContentionRecovery"), "32-way setup pressure must accept only structured retryable lock contention and prove post-contention convergence");
assert(scenarios.includes("setup-failpoint-child.mjs") && !scenarios.includes("HY_WORKFLOW_TEST_FAIL_AT"), "acceptance failpoints must use a test-only child instead of a production environment bypass");
assert(scenarios.includes("if (previewEnvelope.ciConfirmationRequired)") && scenarios.includes('...(artifactReviewArgs.length ? ["--accept-artifact-changes", ...artifactReviewArgs] : [])'), "every repository artifact update must consume an exact dry-run hash review, not only legacy repositories");
assert(scenarios.includes('run("hy-workflow", ["config", "--print-managed-rules"]') && !scenarios.includes('join(workspace.sourceRoot, "AGENTS.md")'), "legacy acceptance migration must consume the installed package rules export, never the source checkout");
assert(failpointChild.includes("internal-setup-test-hooks") && failpointChild.includes("dist/setup-cli.js") && failpointChild.includes("runSetupCli"), "test-only failpoint child must inject the process-local hook before calling the installed tarball CLI");
assert(scenarios.includes("runRepositoryLintPressure") && scenarios.includes("assertCompatibilityUnchanged") && scenarios.includes("lintPressure"), "every pinned repository must execute real doclint/codelint pressure scans and preserve compatibility bytes");
assert(scenarios.includes('run("hy-workflow", ["lint", "--json"]') && !scenarios.includes("prepareLintPressurePackages"), "release pressure must call the installed built-in lint command without third-party preparation");
assert(scenarios.includes("summary.notApplicableRules") && scenarios.includes("DEPENDENCY_SCANNER_EXTENSIONS"), "acceptance must enforce the declared built-in scanner applicability matrix");
for (const forbiddenToken of ["codeload.github.com", "DOCLINT_SOURCE", "CODELINT_SOURCE", "HY_ACCEPTANCE_LINT_ARCHIVE_DIR", "npx --yes --package"]) {
  assert(!scenarios.includes(forbiddenToken), `release pressure must not contain ${forbiddenToken}`);
}
assert(scenarios.includes("verifyCodexProjectShadowBoundary") && scenarios.includes("migrateCodexProjectSectionsExplicitly") && scenarios.includes("setup or unset modified project .codex/config.toml"), "legacy acceptance must fail closed on project Codex shadows and keep migration human-owned");
assert(harness.includes("Acceptance harness refuses remote write command") && runner.includes("remote-write-attempt"), "acceptance must reject and audit remote-write attempts");
assert(harness.includes("const fetchAttempts = 3") && harness.includes('"http.version=HTTP/1.1"') && harness.includes('"shallow.lock"'), "pinned repository clones must use bounded HTTPS retries and clean only temporary Git locks");
assert(harness.includes("ACCEPTANCE_WORKSPACE_LIMIT_BYTES") && scenarios.includes("assertWorkspaceDiskBudget") && runner.includes("workspaceDisk"), "acceptance must enforce and report a fixed recursive workspace disk budget");

console.log("npm-package: all packaging contracts pass");
