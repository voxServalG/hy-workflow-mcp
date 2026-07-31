import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkConfig, defaultSuggestion, ensureConfigDefaults } from "../../src/config.js";
import { projectPaths } from "../../src/runtime/user-paths.js";
import { useRuntimeHome } from "../helpers/runtime-home.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function fixture(branch: string, files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hy-project-matrix-"));
  git(root, ["init", "-b", branch]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf-8");
  }
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fixture"]);
  return root;
}

useRuntimeHome("hy-project-matrix-runtime-");

const matrix: Array<{
  name: string;
  root: string;
  ext: string | string[];
  branch: string;
  ci: string | null;
  notCi?: string;
  docsDir?: string;
}> = [
  {
    name: "vite-like pnpm TypeScript",
    root: fixture("main", {
      "package.json": "{\"scripts\":{\"build\":\"vite build\",\"lint\":\"eslint .\",\"test\":\"vitest run\"}}\n", "pnpm-lock.yaml": "lockfileVersion: '9.0'\n", "tsconfig.json": "{}\n",
      "src/main.ts": "export {};\n", "src/App.tsx": "export {};\n", "docs/index.md": "# Vite\n\nBuild and test facts.\n",
    }),
    ext: [".ts", ".tsx"], branch: "main", ci: "pnpm install --frozen-lockfile",
  },
  {
    name: "express-like lockless JavaScript",
    root: fixture("master", {
      "package.json": "{}\n", "lib/app.js": "module.exports = {};\n", "Readme.md": "# Express\n\nRuntime and testing facts.\n",
    }),
    ext: ".js", branch: "master", ci: null,
  },
  {
    name: "Yarn Classic TypeScript",
    root: fixture("main", {
      "package.json": "{\"scripts\":{\"test\":\"node --test\"}}\n", "yarn.lock": "# yarn lockfile v1\n", "tsconfig.json": "{}\n",
      "src/index.ts": "export {};\n", "docs/index.md": "# Yarn Classic\n\nBuild and test facts.\n",
    }),
    ext: ".ts", branch: "main", ci: "yarn install --frozen-lockfile", notCi: "yarn install --immutable",
  },
  {
    name: "Yarn Berry TypeScript",
    root: fixture("main", {
      "package.json": "{\"packageManager\":\"yarn@4.5.0\",\"scripts\":{\"typecheck\":\"tsc --noEmit\",\"test\":\"node --test\"}}\n",
      "yarn.lock": "__metadata:\n  version: 8\n", ".yarnrc.yml": "nodeLinker: node-modules\n", "tsconfig.json": "{}\n",
      "src/index.ts": "export {};\n", "docs/index.md": "# Yarn Berry\n\nBuild and test facts.\n",
    }),
    ext: ".ts", branch: "main", ci: "yarn install --immutable", notCi: "yarn install --frozen-lockfile",
  },
  {
    name: "Bun JavaScript",
    root: fixture("main", {
      "package.json": "{\"packageManager\":\"bun@1.2.0\",\"scripts\":{\"check\":\"node --check src/index.js\",\"test\":\"node --test\"}}\n",
      "src/index.js": "export {};\n", "docs/index.md": "# Bun\n\nBuild and test facts.\n",
    }),
    ext: ".js", branch: "main", ci: "bun install --frozen-lockfile",
  },
  {
    name: "flask-like Python",
    root: fixture("main", {
      "pyproject.toml": "[project]\nname='flask-like'\n", "src/flask/app.py": "print('ok')\n",
      "docs/index.rst": "Flask\n=====\n\nApplication facts and verification.\n",
      "README.md": "# Flask-like\n\nThe root Markdown file is the doclint fallback for RST-only documentation.\n",
    }),
    ext: ".py", branch: "main", ci: null, notCi: "python -m pip install -e .", docsDir: ".",
  },
  {
    name: "github-cli-like Go",
    root: fixture("trunk", {
      "go.mod": "module example.test/cli\n\ngo 1.22\n", "cmd/tool/main.go": "package main\nfunc main() {}\n",
      "docs/index.md": "# CLI\n\nCommand and platform facts.\n",
    }),
    ext: ".go", branch: "trunk", ci: "go test ./...",
  },
  {
    name: "ripgrep-like Rust",
    root: fixture("master", {
      "Cargo.toml": "[package]\nname='search'\nversion='1.0.0'\n", "crates/core/src/lib.rs": "pub fn run() {}\n",
      "README.md": "# Search\n\nWorkspace and performance facts.\n",
    }),
    ext: ".rs", branch: "master", ci: "cargo test --workspace --all-targets", notCi: "cargo test --workspace --all-targets --locked",
  },
];

for (const item of matrix) {
  const suggestion = defaultSuggestion(item.root);
  assert(JSON.stringify(suggestion.codeExt) === JSON.stringify(item.ext), `${item.name}: wrong extension ${JSON.stringify(suggestion.codeExt)}`);
  assert(suggestion.baseBranch === item.branch, `${item.name}: wrong base branch ${suggestion.baseBranch}`);
  if (item.docsDir) assert(suggestion.docsDir === item.docsDir, `${item.name}: wrong docsDir ${suggestion.docsDir}`);
  if (item.ci) assert(suggestion.ciCommands.includes(item.ci), `${item.name}: missing native CI candidate ${item.ci}`);
  else assert(suggestion.ciCommands.length === 0, `${item.name}: projects without a provable verification command must fail closed`);
  if (item.notCi) assert(!suggestion.ciCommands.includes(item.notCi), `${item.name}: incompatible install command must not be inferred: ${item.notCi}`);
  const applied = ensureConfigDefaults(item.root);
  assert(applied.ok, `${item.name}: unambiguous project suggestion should apply: ${applied.issues.join("; ")}`);
  assert(checkConfig(item.root).ok, `${item.name}: generated config should remain valid`);
  assert(!fs.existsSync(path.join(item.root, "hy-workflow.json")), `${item.name}: config helper must not inject a root config without exact project authority`);
  const externalConfig = projectPaths(item.root).config;
  assert(applied.source === externalConfig && fs.existsSync(externalConfig), `${item.name}: config helper must write the identity-scoped external config`);
  const config = JSON.parse(fs.readFileSync(externalConfig, "utf-8"));
  assert(config.ci === undefined, `${item.name}: CI candidates require setup/user confirmation and must not be silently persisted`);
}

const ambiguous = fixture("main", {
  "package.json": "{}\n",
  "README.md": "# Empty package\n\nThe implementation language has not been chosen.\n",
});
const ambiguousDryRun = ensureConfigDefaults(ambiguous, { dryRun: true });
assert(
  !ambiguousDryRun.ok && ambiguousDryRun.project?.confidence === "low" && ambiguousDryRun.project?.ambiguous === true,
  "low-confidence projects must fail closed and expose ambiguity facts instead of silently selecting TypeScript/src",
);
assert(!fs.existsSync(path.join(ambiguous, "hy-workflow.json")), "ambiguous dry-run must not write a root config");

const mixed = fixture("main", {
  "pyproject.toml": "[project]\nname='mixed'\n", "package.json": "{}\n", "tsconfig.json": "{}\n",
  "backend/app.py": "print('ok')\n", "frontend/app.ts": "export {};\n",
  "docs/index.md": "# Mixed project\n\nBoth components require explicit configuration.\n",
});
const mixedDryRun = ensureConfigDefaults(mixed, { dryRun: true });
assert(
  !mixedDryRun.ok && mixedDryRun.project?.kind === "mixed" && mixedDryRun.project?.ambiguous === true,
  "material mixed ecosystems must fail closed and expose facts requiring explicit code extension/directory confirmation",
);
assert(!fs.existsSync(path.join(mixed, "hy-workflow.json")), "mixed inference must not write before confirmation");
