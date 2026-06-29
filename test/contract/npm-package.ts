import { readPackageJson, npmPackDryRun } from "../../src/npm/package.js";
import { execSync } from "node:child_process";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const pkg = readPackageJson(process.cwd());

// bin and main point at dist/server.js
assert(pkg.main === "dist/server.js", "package.json main must be dist/server.js");
assert(pkg.bin?.["hy-workflow"] === "dist/server.js", "hy-workflow bin must point at dist/server.js");

// prepare script exists and builds dist
assert(typeof pkg.scripts?.prepare === "string", "package.json must have a prepare script");
assert(pkg.scripts.prepare.includes("build"), "prepare script must build dist");

// files must include dist, docs, setup, setup.ps1, README.md
const requiredFiles = ["dist", "docs", "setup", "setup.ps1", "README.md"];
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
for (const file of packFiles) {
  for (const prefix of forbidden) {
    assert(!file.startsWith(prefix), `npm pack must not include ${file}`);
  }
}

console.log("npm-package: all packaging contracts pass");
