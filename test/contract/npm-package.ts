import { readPackageJson, npmPackDryRun, parseNpmPackFiles } from "../../src/npm/package.js";
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

// publishing builds dist, but installing the registry package never compiles locally
assert(pkg.scripts?.prepack === "npm run build", "prepack must build the npm-only dist directory");
assert(pkg.scripts?.prepublishOnly === "npm run verify", "prepublishOnly must run the full verification suite");
for (const lifecycle of ["prepare", "install", "postinstall"]) {
  assert(pkg.scripts?.[lifecycle] === undefined, `${lifecycle} must not build during npm install`);
}

// files include compiled runtime, docs, shared templates, and README; platform scripts are gone
const requiredFiles = ["dist", "docs", "templates", "README.md"];
for (const file of requiredFiles) {
  assert(pkg.files?.includes(file), `package.json files must include ${file}`);
}

// required npm scripts
const requiredScripts = ["build", "lint:contract", "test", "test:unit", "test:e2e", "test:contract", "verify"];
for (const script of requiredScripts) {
  assert(typeof pkg.scripts?.[script] === "string", `Missing required npm script: ${script}`);
}

// dist must not be tracked by git
const tracked = execSync("git ls-files", { cwd: process.cwd(), encoding: "utf-8", stdio: ["pipe","pipe","pipe"] }).trim().split("\n").filter(Boolean);
const trackedDist = tracked.filter((f: string) => f.startsWith("dist/"));
assert(trackedDist.length === 0, `dist files must not be tracked by git, found ${trackedDist.length}: ${trackedDist.slice(0, 3).join(", ")}`);

// npm pack dry-run must exclude source, test, and local artifacts
const forbidden = [".hy/", ".opencode/", ".codex/", "test/", "src/", "codelint.json", "doclint.json", "docs-gardener.json"];
const packFiles = npmPackDryRun(process.cwd());
assert(packFiles.includes("dist/server.js"), "npm pack must include the compiled CLI entrypoint");
assert(packFiles.includes("templates/hy-workflow.yml"), "npm pack must include the explicit shared-mode workflow template");
assert(!packFiles.includes("setup") && !packFiles.includes("setup.ps1"), "npm pack must not include removed platform installers");
for (const file of packFiles) {
  for (const prefix of forbidden) {
    assert(!file.startsWith(prefix), `npm pack must not include ${file}`);
  }
}

// publishing uses npm trusted publishing; GitHub never stores the compiled output
const workflow = readFileSync(".github/workflows/npm-publish.yml", "utf8");
assert(workflow.includes("id-token: write"), "npm publish workflow must request an OIDC id-token");
assert(workflow.includes("npm publish --access public --tag next"), "prereleases must publish with the next tag");
assert(workflow.includes("npm publish --access public --tag latest"), "stable releases must publish with the latest tag");
for (const forbiddenToken of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "upload-artifact", "gh release upload", "actions/attest-build-provenance"]) {
  assert(!workflow.includes(forbiddenToken), `npm publish workflow must not contain ${forbiddenToken}`);
}

console.log("npm-package: all packaging contracts pass");
