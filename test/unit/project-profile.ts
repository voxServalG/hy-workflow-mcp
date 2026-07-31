import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inferBaseBranch, inspectProject, validateBaseBranch } from "../../src/project-profile.js";
import { MINIMAL_PROJECT_CONTRACT, writeDeployment } from "../../src/runtime/deployment.js";
import { useRuntimeHome } from "../helpers/runtime-home.js";

useRuntimeHome("hy-project-profile-runtime-");

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function write(root: string, file: string, content = "content\n"): void {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
}

function repository(branch: string, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hy-project-profile-"));
  git(root, ["init", "-b", branch]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  for (const [file, content] of Object.entries(files)) write(root, file, content);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init"]);
  return root;
}

const packageOnly = repository("main", {
  "package.json": "{}\n",
  "docs/index.md": "# Project facts\n\nThis repository intentionally has no source yet.\n",
});
const packageOnlyProfile = inspectProject(packageOnly);
assert(packageOnlyProfile.kind === "unknown", "package.json alone must not masquerade as TypeScript");
assert(packageOnlyProfile.ambiguous && packageOnlyProfile.confidence === "low", "source-free package projects must require confirmation");

const legacyNoise = repository("main", {
  "pyproject.toml": "[project]\nname='legacy-noise'\n",
  "src/app.py": "print('ok')\n",
  "docs/index.md": "# Maintained facts\n\nOnly configured project facts count.\n",
  "AGENTS.md": "legacy rules\n",
  "hy-workflow.json": "{ invalid legacy config\n",
  ".github/workflows/hy-workflow.yml": "legacy workflow\n",
  ".codex/poison.ts": "export {}\n",
  ".opencode/poison.go": "package poison\n",
  ".hy/runtime.rs": "fn poison() {}\n",
  "codelint.json": "{}\n",
  "doclint.json": "{}\n",
  "docs-gardener.json": "{}\n",
});
const unreadableLegacyNoise = ["AGENTS.md", "hy-workflow.json", ".github/workflows/hy-workflow.yml", ".codex/poison.ts", ".opencode/poison.go", ".hy/runtime.rs", "codelint.json", "doclint.json", "docs-gardener.json"];
for (const ignored of unreadableLegacyNoise) fs.chmodSync(path.join(legacyNoise, ignored), 0o000);
const legacyNoiseProfile = inspectProject(legacyNoise);
assert(legacyNoiseProfile.kind === "python", `legacy injection source files must not affect ecosystem detection: ${JSON.stringify(legacyNoiseProfile)}`);
for (const ignored of unreadableLegacyNoise) {
  assert(!legacyNoiseProfile.trackedFiles.includes(ignored), `project profile must ignore legacy injection ${ignored}`);
  fs.chmodSync(path.join(legacyNoise, ignored), 0o644);
}

const minimal = repository("main", {
  "package.json": "{}\n",
  "src/index.ts": "export {}\n",
  "docs/index.md": "# Minimal project\n\nProject facts.\n",
  "hy-workflow.json": "{}\n",
  ".github/workflows/hy-workflow.yml": "name: hy-workflow\n",
});
writeDeployment(minimal, {
  setupVersion: "test",
  mode: "shared",
  clients: [],
  projectFiles: ["hy-workflow.json", ".github/workflows/hy-workflow.yml"],
  tools: {},
  artifacts: {},
  projectContract: MINIMAL_PROJECT_CONTRACT,
});
const minimalProfile = inspectProject(minimal);
assert(minimalProfile.trackedFiles.includes("hy-workflow.json") && minimalProfile.trackedFiles.includes(".github/workflows/hy-workflow.yml"), "minimal-v1 project artifacts must remain strict authoritative inputs");

const typescript = repository("main", {
  "package.json": "{}\n",
  "tsconfig.json": "{}\n",
  "src/index.ts": "export const value = 1;\n",
  "src/view.tsx": "export const View = () => null;\n",
  "scripts/build.mjs": "export {};\n",
  "docs/index.rst": "Project\n=======\n\nMaintained facts live here.\n",
});
const tsProfile = inspectProject(typescript);
assert(tsProfile.kind === "typescript", `TypeScript should be detected: ${JSON.stringify(tsProfile)}`);
assert(tsProfile.docsDir === "" && tsProfile.issues.some(issue => issue.includes("scannable .md")), "RST-only documentation must not produce an empty-green doclint root");
assert(JSON.stringify([...tsProfile.codeExt].sort()) === JSON.stringify([".mjs", ".ts", ".tsx"]), `multi-extension evidence must be retained: ${JSON.stringify(tsProfile.codeExt)}`);
assert(tsProfile.codeDirs.includes("src") && tsProfile.codeDirs.includes("scripts"), "tracked source directories should drive codeDirs");
assert(tsProfile.baseBranch === "main" && validateBaseBranch(typescript, "main").ok, "current main commit should be a valid base ref");
assert(!validateBaseBranch(typescript, "missing").ok, "missing base refs must fail validation");

const javascript = repository("master", {
  "package.json": "{}\n",
  "lib/app.js": "module.exports = {};\n",
  "ReadMe.md": "# Express-like project\n\nRuntime behavior is documented.\n",
});
const jsProfile = inspectProject(javascript);
assert(jsProfile.kind === "javascript" && jsProfile.codeExt === ".js", `pure JavaScript must remain JavaScript: ${JSON.stringify(jsProfile)}`);
assert(jsProfile.docsDir === ".", "case-insensitive root README should support docsDir dot without choosing a dependency README");
assert(jsProfile.baseBranch === "master", "master should be inferred from the current resolvable branch");

const unlockedNpm = repository("master", {
  "package.json": JSON.stringify({ scripts: { lint: "eslint .", test: "node --test" } }) + "\n",
  "lib/app.js": "module.exports = {};\n",
  "README.md": "# Unlocked package\n",
});
assert(JSON.stringify(inspectProject(unlockedNpm).ciCandidates) === JSON.stringify(["npm install --no-package-lock", "npm run lint", "npm run test"]), "npm projects with checks but no lockfile must install without mutating a package lock before verification");

const rstDocsWithRootMarkdown = repository("main", {
  "pyproject.toml": "[project]\nname='rst-docs'\n",
  "src/app.py": "print('ok')\n",
  "docs/index.rst": "RST docs\n========\n",
  "README.md": "# Project overview\n",
});
assert(inspectProject(rstDocsWithRootMarkdown).docsDir === ".", "RST-only docs directory must fall back to a scannable root README.md");

const yarnClassic = repository("main", {
  "package.json": JSON.stringify({ scripts: { test: "node --test" } }) + "\n",
  "yarn.lock": "# yarn lockfile v1\n",
  "src/index.ts": "export {};\n",
  "tsconfig.json": "{}\n",
  "docs/index.md": "# Yarn Classic\n\nProject facts.\n",
});
const yarnClassicCi = inspectProject(yarnClassic).ciCandidates;
assert(yarnClassicCi.includes("yarn install --frozen-lockfile") && !yarnClassicCi.includes("yarn install --immutable"), `Yarn Classic must use frozen-lockfile: ${JSON.stringify(yarnClassicCi)}`);

const yarnBerry = repository("main", {
  "package.json": JSON.stringify({ packageManager: "yarn@4.5.0", scripts: { typecheck: "tsc --noEmit", test: "node --test" } }) + "\n",
  "yarn.lock": "__metadata:\n  version: 8\n",
  ".yarnrc.yml": "nodeLinker: node-modules\n",
  "src/index.ts": "export {};\n",
  "tsconfig.json": "{}\n",
  "docs/index.md": "# Yarn Berry\n\nProject facts.\n",
});
const yarnBerryCi = inspectProject(yarnBerry).ciCandidates;
assert(yarnBerryCi.includes("yarn install --immutable") && !yarnBerryCi.includes("yarn install --frozen-lockfile"), `Yarn Berry must use immutable installs: ${JSON.stringify(yarnBerryCi)}`);
assert(yarnBerryCi.includes("yarn run typecheck"), `standard typecheck scripts must be inferred: ${JSON.stringify(yarnBerryCi)}`);

const bun = repository("main", {
  "package.json": JSON.stringify({ packageManager: "bun@1.2.0", scripts: { check: "node --check src/index.js", test: "node --test" } }) + "\n",
  "src/index.js": "export {};\n",
  "docs/index.md": "# Bun\n\nProject facts.\n",
});
const bunCi = inspectProject(bun).ciCandidates;
assert(bunCi.includes("bun install --frozen-lockfile") && bunCi.includes("bun run check"), `Bun packageManager and check scripts must be inferred: ${JSON.stringify(bunCi)}`);

const jsFamilyMixed = repository("main", {
  "package.json": JSON.stringify({ scripts: { typecheck: "tsc --noEmit", check: "node --check src/index.js", test: "node --test" } }) + "\n",
  "package-lock.json": "{}\n",
  "tsconfig.json": "{}\n",
  "index.d.ts": "export {};\n",
  "src/index.js": "export {};\n",
  "src/other.js": "export {};\n",
  "src/a.js": "export {};\n",
  "src/b.js": "export {};\n",
  "src/c.js": "export {};\n",
  "src/d.js": "export {};\n",
  "src/e.js": "export {};\n",
  "src/f.js": "export {};\n",
  "src/g.js": "export {};\n",
  "src/h.js": "export {};\n",
  "src/i.js": "export {};\n",
  "src/j.js": "export {};\n",
  "src/k.js": "export {};\n",
  "docs/index.md": "# JS package\n\nProject facts.\n",
});
const mixedNodeProfile = inspectProject(jsFamilyMixed);
assert(mixedNodeProfile.kind === "mixed", `JS plus declaration sources should retain mixed evidence: ${JSON.stringify(mixedNodeProfile)}`);
for (const command of ["npm ci", "npm run typecheck", "npm run check", "npm run test"]) {
  assert(mixedNodeProfile.ciCandidates.includes(command), `JS-family mixed projects must infer ${command}: ${JSON.stringify(mixedNodeProfile.ciCandidates)}`);
}

const python = repository("main", {
  "pyproject.toml": "[project]\nname='demo'\n",
  "src/app.py": "print('ok')\n",
  "docs/index.md": "# Python service\n\nService constraints and tests.\n",
});
assert(inspectProject(python).kind === "python", "pyproject plus tracked Python source should detect Python");
assert(inspectProject(python).ciCandidates.length === 0, "Python profile must not treat installation alone as verification when no tracked test evidence exists");

const configuredPython = repository("main", {
  "pyproject.toml": "[project]\nname='configured'\n\n[tool.pytest.ini_options]\naddopts='-q'\n",
  "src/app.py": "print('ok')\n",
  "docs/index.md": "# Configured Python\n\nProject facts.\n",
});
assert(inspectProject(configuredPython).ciCandidates.includes("python -m pytest"), "tracked pytest configuration should enable the pytest candidate");

const dualManifestPython = repository("main", {
  "pyproject.toml": "[project]\nname='dual-manifest'\n",
  "requirements.txt": "pytest>=8\n",
  "src/app.py": "print('ok')\n",
  "tests/test_app.py": "def test_ok(): assert True\n",
  "docs/index.md": "# Dual manifest Python\n\nProject facts.\n",
});
assert(JSON.stringify(inspectProject(dualManifestPython).ciCandidates) === JSON.stringify(["python -m pip install -r requirements.txt", "python -m pip install -e .", "python -m pytest"]), "Python inference must retain every required install before real verification");

const setupPyPython = repository("main", {
  "setup.py": "from setuptools import setup\nsetup(name='legacy')\n",
  "src/app.py": "print('ok')\n",
  "test/test_app.py": "def test_ok(): assert True\n",
  "README.md": "# Legacy Python\n\nProject facts.\n",
});
assert(JSON.stringify(inspectProject(setupPyPython).ciCandidates) === JSON.stringify(["python -m pip install -e .", "python -m pytest"]), "setup.py projects with tests must install before pytest");

const customPythonDirs = repository("main", {
  "pyproject.toml": "[project]\nname='experiments'\n",
  "src/app.py": "print('ok')\n",
  "tests/test_app.py": "print('test')\n",
  "experiments/first.py": "print('one')\n",
  "experiments/second.py": "print('two')\n",
  "docs/index.md": "# Experiments\n\nProject facts.\n",
});
const customPythonProfile = inspectProject(customPythonDirs);
assert(customPythonProfile.codeDirs.includes("experiments"), `material custom source directories must not be dropped when common directories exist: ${JSON.stringify(customPythonProfile.codeDirs)}`);
assert(!customPythonProfile.lintDirs.includes("tests"), `test directories remain outside default lint scope without explicit project configuration: ${JSON.stringify(customPythonProfile.lintDirs)}`);
assert(customPythonProfile.ciCandidates.includes("python -m pytest"), "tracked Python test sources should enable the pytest candidate");

const go = repository("trunk", {
  "go.mod": "module example.test/demo\n\ngo 1.22\n",
  "cmd/demo/main.go": "package main\nfunc main() {}\n",
  "README.rst": "Go project\n==========\n\nProject facts.\n",
});
const goProfile = inspectProject(go);
assert(goProfile.kind === "go" && goProfile.codeExt === ".go", `Go must not fall back to shell: ${JSON.stringify(goProfile)}`);
assert(inferBaseBranch(go).branch === "trunk", "trunk should be accepted as a real base branch");
assert(goProfile.ciCandidates[0] === "go test ./...", "Go profile should expose native tests");

const rust = repository("main", {
  "Cargo.toml": "[package]\nname='demo'\nversion='0.1.0'\n",
  "crates/core/src/lib.rs": "pub fn value() -> u8 { 1 }\n",
  "docs/README.md": "# Rust workspace\n\nWorkspace rules and verification.\n",
});
const rustProfile = inspectProject(rust);
assert(rustProfile.kind === "rust" && rustProfile.codeDirs.includes("crates"), `Rust workspace directories should be inferred: ${JSON.stringify(rustProfile)}`);
assert(JSON.stringify(rustProfile.ciCandidates) === JSON.stringify(["cargo test --workspace --all-targets"]), "Rust projects without Cargo.lock must verify every workspace target without --locked");

write(rust, "Cargo.lock", "# lock\n");
git(rust, ["add", "Cargo.lock"]);
git(rust, ["commit", "-m", "add lockfile"]);
assert(JSON.stringify(inspectProject(rust).ciCandidates) === JSON.stringify(["cargo test --workspace --all-targets --locked"]), "tracked Cargo.lock should enable locked verification for every workspace target");

write(rust, "scripts/release.py", "print('release')\n");
git(rust, ["add", "scripts/release.py"]);
git(rust, ["commit", "-m", "auxiliary script"]);
assert(inspectProject(rust).kind === "rust", "one auxiliary script must not turn a Rust repository into a material mixed project");

const mixed = repository("main", {
  "pyproject.toml": "[project]\nname='mixed'\n",
  "package.json": "{}\n",
  "tsconfig.json": "{}\n",
  "backend/app.py": "print('ok')\n",
  "frontend/app.ts": "export {};\n",
  "docs/index.md": "# Mixed system\n\nBoth components are maintained.\n",
});
const mixedProfile = inspectProject(mixed);
assert(mixedProfile.kind === "mixed" && mixedProfile.ambiguous, "material multi-ecosystem projects must fail closed for explicit confirmation");
