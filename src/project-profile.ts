import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { isKnownCodeExt, type CodeExt } from "./code_ext.js";

export type ProjectEcosystem = "typescript" | "javascript" | "python" | "go" | "rust";
export type ProjectKind = ProjectEcosystem | "mixed" | "unknown";
export type ProfileConfidence = "high" | "medium" | "low";

export interface BaseBranchInference {
  branch: string;
  confidence: ProfileConfidence;
  evidence: string[];
  valid: boolean;
}

export interface ProjectProfile {
  root: string;
  kind: ProjectKind;
  ecosystems: ProjectEcosystem[];
  codeExt: CodeExt;
  codeDirs: string[];
  lintDirs: string[];
  docsDir: string;
  baseBranch: string;
  confidence: ProfileConfidence;
  ambiguous: boolean;
  evidence: string[];
  issues: string[];
  trackedFiles: string[];
  ciCandidates: string[];
}

const IGNORED_SEGMENTS = new Set([
  ".git", "node_modules", "dist", "build", "coverage", "vendor", "target",
  ".venv", "venv", "__pycache__", ".tox", ".mypy_cache", ".pytest_cache",
]);

const EXTENSIONS: Record<ProjectEcosystem, Set<string>> = {
  typescript: new Set([".ts", ".tsx"]),
  javascript: new Set([".js", ".jsx", ".mjs", ".cjs"]),
  python: new Set([".py", ".pyw", ".pyi"]),
  go: new Set([".go"]),
  rust: new Set([".rs"]),
};

const MANIFESTS: Record<ProjectEcosystem, string[]> = {
  typescript: ["tsconfig.json"],
  javascript: [],
  python: ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile"],
  go: ["go.mod"],
  rust: ["Cargo.toml"],
};

const COMMON_CODE_DIRS = new Set([
  "src", "lib", "app", "apps", "packages", "crates", "cmd", "internal", "pkg",
  "scripts", "test", "tests",
]);

function slash(value: string): string {
  return value.split(path.sep).join("/");
}

function safeReadDir(root: string): fs.Dirent[] {
  try { return fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
}

function followedDirectory(root: string, full: string, entry: fs.Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    const real = fs.realpathSync(full);
    const relative = path.relative(path.resolve(root), real);
    return !relative.startsWith("..") && !path.isAbsolute(relative) && fs.statSync(real).isDirectory();
  } catch { return false; }
}

function ignored(file: string): boolean {
  return slash(file).split("/").some(segment => IGNORED_SEGMENTS.has(segment));
}

function filesystemFiles(root: string, limit = 20_000): string[] {
  const files: string[] = [];
  const visited = new Set<string>();
  const walk = (current: string): void => {
    if (files.length >= limit) return;
    let real: string;
    try { real = fs.realpathSync(current); } catch { return; }
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of safeReadDir(current)) {
      if (files.length >= limit || IGNORED_SEGMENTS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (followedDirectory(root, full, entry)) walk(full);
      else if (entry.isFile()) files.push(slash(path.relative(root, full)));
    }
  };
  walk(root);
  return files.sort();
}

export function trackedProjectFiles(root: string): { files: string[]; source: "git" | "filesystem" } {
  try {
    const stdout = execFileSync("git", ["ls-files", "-z", "--cached"], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const files = stdout.split("\0").filter(Boolean).map(slash).filter(file => !ignored(file)).sort();
    return { files, source: "git" };
  } catch {
    // Config unit tests and recovery commands can inspect a directory before Git
    // exists. The profile is deliberately low-confidence in this fallback.
    return { files: filesystemFiles(root), source: "filesystem" };
  }
}

function hasFile(files: string[], candidate: string): boolean {
  const lower = candidate.toLowerCase();
  return files.some(file => file.toLowerCase() === lower);
}

function sourceCounts(files: string[]): Record<ProjectEcosystem, number> {
  const counts: Record<ProjectEcosystem, number> = {
    typescript: 0,
    javascript: 0,
    python: 0,
    go: 0,
    rust: 0,
  };
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    for (const ecosystem of Object.keys(EXTENSIONS) as ProjectEcosystem[]) {
      if (EXTENSIONS[ecosystem].has(ext)) counts[ecosystem] += 1;
    }
  }
  return counts;
}

function ecosystemScores(files: string[], counts: Record<ProjectEcosystem, number>): Record<ProjectEcosystem, number> {
  const scores = { ...counts };
  for (const ecosystem of Object.keys(MANIFESTS) as ProjectEcosystem[]) {
    scores[ecosystem] += MANIFESTS[ecosystem].filter(marker => hasFile(files, marker)).length * 8;
  }
  // package.json is evidence for the JS family, never TypeScript by itself.
  if (hasFile(files, "package.json")) {
    if (counts.typescript > 0 || hasFile(files, "tsconfig.json")) scores.typescript += 3;
    else if (counts.javascript > 0) scores.javascript += 3;
  }
  return scores;
}

function detectedEcosystems(
  files: string[],
  counts: Record<ProjectEcosystem, number>,
  scores: Record<ProjectEcosystem, number>,
): ProjectEcosystem[] {
  return (Object.keys(scores) as ProjectEcosystem[])
    .filter(ecosystem => scores[ecosystem] > 0 && (
      counts[ecosystem] > 0 || MANIFESTS[ecosystem].some(marker => hasFile(files, marker))
    ))
    .sort((a, b) => scores[b] - scores[a] || a.localeCompare(b));
}

function projectKind(ecosystems: ProjectEcosystem[], counts: Record<ProjectEcosystem, number>, files: string[]): ProjectKind {
  if (!ecosystems.length) return "unknown";
  const primary = ecosystems[0];
  const primaryCount = Math.max(1, counts[primary]);
  const material = ecosystems.filter(ecosystem => ecosystem === primary || (
    counts[ecosystem] > 0 && (
      MANIFESTS[ecosystem].some(marker => hasFile(files, marker)) ||
      (counts[ecosystem] >= 3 && counts[ecosystem] / primaryCount >= 0.2)
    )
  ));
  // TypeScript repositories commonly contain a small amount of JS tooling.
  if (primary === "typescript" && material.every(item => item === "typescript" || item === "javascript")) {
    return "typescript";
  }
  if (material.length > 1) return "mixed";
  return primary;
}

function selectedExtensions(kind: ProjectKind, ecosystems: ProjectEcosystem[], files: string[]): string[] {
  const allowed = new Set<string>();
  const selected = kind === "typescript"
    ? ecosystems.filter(item => item === "typescript" || item === "javascript")
    : kind === "mixed" ? ecosystems : kind === "unknown" ? [] : [kind];
  for (const ecosystem of selected) {
    for (const ext of EXTENSIONS[ecosystem]) allowed.add(ext);
  }
  if (kind === "unknown") {
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (isKnownCodeExt(ext) && ![".md", ".markdown", ".rst", ".txt"].includes(ext)) allowed.add(ext);
    }
  }
  const counts = new Map<string, number>();
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (allowed.has(ext)) counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([ext]) => ext);
}

function codeDirectories(files: string[], extensions: string[]): string[] {
  const extSet = new Set(extensions);
  const counts = new Map<string, number>();
  let rootFiles = 0;
  for (const file of files) {
    if (!extSet.has(path.extname(file).toLowerCase())) continue;
    const parts = slash(file).split("/");
    if (parts.length === 1) {
      rootFiles += 1;
      continue;
    }
    const top = parts[0];
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  const common = [...counts.entries()]
    .filter(([dir]) => COMMON_CODE_DIRS.has(dir.toLowerCase()))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([dir]) => dir);
  const material = [...counts.entries()]
    .filter(([dir, count]) => !COMMON_CODE_DIRS.has(dir.toLowerCase()) && count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([dir]) => dir);
  const selected = [...common, ...material];
  if (selected.length) return selected;
  return rootFiles ? ["."] : [];
}

function docsDirectory(root: string, files: string[]): string {
  const entries = safeReadDir(root);
  for (const candidate of ["docs", "documentation", "doc"]) {
    const exact = entries.find(entry => followedDirectory(root, path.join(root, entry.name), entry) && entry.name === candidate);
    const folded = entries.find(entry => followedDirectory(root, path.join(root, entry.name), entry) && entry.name.toLowerCase() === candidate);
    const selected = exact ?? folded;
    if (selected && files.some(file => file.startsWith(`${selected.name}/`) && file.endsWith(".md"))) return selected.name;
  }
  const rootDoc = entries.some(entry => entry.isFile() && entry.name.endsWith(".md") && /^(readme|index)\.md$/i.test(entry.name));
  return rootDoc ? "." : "";
}

function gitOutput(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function gitRefExists(root: string, branch: string): boolean {
  if (!branch) return false;
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    if (gitOutput(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) return true;
  }
  return false;
}

export function inferBaseBranch(root: string): BaseBranchInference {
  const evidence: string[] = [];
  const originHead = gitOutput(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
    ?.replace(/^origin\//, "");
  if (originHead && gitRefExists(root, originHead)) {
    return { branch: originHead, confidence: "high", evidence: [`origin HEAD: ${originHead}`], valid: true };
  }
  if (originHead) evidence.push(`origin HEAD is not a resolvable commit: ${originHead}`);

  const current = gitOutput(root, ["branch", "--show-current"]);
  if (current && gitRefExists(root, current)) {
    const conventional = ["main", "master", "trunk", "dev", "develop"].includes(current);
    return {
      branch: current,
      confidence: conventional ? "high" : "medium",
      evidence: [...evidence, `current branch: ${current}`],
      valid: true,
    };
  }
  if (current) evidence.push(`current branch is not a resolvable commit: ${current}`);

  for (const candidate of ["main", "master", "trunk", "dev", "develop"]) {
    if (gitRefExists(root, candidate)) {
      return { branch: candidate, confidence: "medium", evidence: [...evidence, `existing fallback ref: ${candidate}`], valid: true };
    }
  }
  return { branch: "dev", confidence: "low", evidence: [...evidence, "no resolvable base branch; explicit confirmation required"], valid: false };
}

export function validateBaseBranch(root: string, branch: string): { ok: boolean; issue?: string } {
  if (gitRefExists(root, branch)) return { ok: true };
  return {
    ok: false,
    issue: `hy-workflow.json project.baseBranch does not resolve to a local or origin commit: ${branch}`,
  };
}

type PackageMetadata = { scripts: Set<string>; packageManager: string };

function packageMetadata(root: string): PackageMetadata {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
    const scripts = parsed?.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts) ? parsed.scripts : {};
    return {
      scripts: new Set(Object.entries(scripts).filter(([, value]) => typeof value === "string" && value.trim()).map(([name]) => name)),
      packageManager: typeof parsed?.packageManager === "string" ? parsed.packageManager : "",
    };
  } catch { return { scripts: new Set(), packageManager: "" }; }
}

function trackedFile(files: string[], candidate: string): string | undefined {
  const lower = candidate.toLowerCase();
  return files.find(file => file.toLowerCase() === lower);
}

function trackedFileMatches(root: string, files: string[], candidate: string, pattern: RegExp): boolean {
  const file = trackedFile(files, candidate);
  if (!file) return false;
  try { return pattern.test(fs.readFileSync(path.join(root, file), "utf-8")); }
  catch { return false; }
}

function hasPythonTestEvidence(root: string, files: string[]): boolean {
  const hasTestSource = files.some(file => {
    const normalized = slash(file).toLowerCase();
    if (!EXTENSIONS.python.has(path.extname(normalized))) return false;
    const basename = path.posix.basename(normalized);
    return /(^|\/)(tests?|test)\//.test(normalized)
      || /^test_.*\.py(?:w|i)?$/.test(basename)
      || /_test\.py(?:w|i)?$/.test(basename)
      || basename === "conftest.py";
  });
  if (hasTestSource || hasFile(files, "pytest.ini")) return true;
  return trackedFileMatches(root, files, "pyproject.toml", /\[tool\.pytest(?:\.|\])/i)
    || trackedFileMatches(root, files, "setup.cfg", /\[tool:pytest\]/i)
    || trackedFileMatches(root, files, "tox.ini", /(?:^|\s)pytest(?:\s|$)/im);
}

function ciCandidates(root: string, kind: ProjectKind, ecosystems: ProjectEcosystem[], files: string[]): string[] {
  const nodeProject = kind === "typescript" || kind === "javascript" || (
    kind === "mixed" && ecosystems.length > 0 && ecosystems.every(item => item === "typescript" || item === "javascript")
  );
  if (nodeProject) {
    const metadata = packageMetadata(root);
    const checks = ["build", "typecheck", "check", "lint", "test"].filter(name => metadata.scripts.has(name));
    if (!checks.length) return [];
    if (hasFile(files, "pnpm-lock.yaml") || metadata.packageManager.startsWith("pnpm@")) {
      return ["corepack enable", "pnpm install --frozen-lockfile", ...checks.map(name => `pnpm run ${name}`)];
    }
    if (hasFile(files, "yarn.lock") || metadata.packageManager.startsWith("yarn@")) {
      const yarnV1 = /^yarn@1(?:\.|$)/.test(metadata.packageManager) || (!metadata.packageManager && !hasFile(files, ".yarnrc.yml"));
      const install = yarnV1 ? "yarn install --frozen-lockfile" : "yarn install --immutable";
      return ["corepack enable", install, ...checks.map(name => `yarn run ${name}`)];
    }
    if (hasFile(files, "bun.lock") || hasFile(files, "bun.lockb") || metadata.packageManager.startsWith("bun@")) {
      return ["bun install --frozen-lockfile", ...checks.map(name => `bun run ${name}`)];
    }
    if (hasFile(files, "package-lock.json") || hasFile(files, "npm-shrinkwrap.json")) return ["npm ci", ...checks.map(name => `npm run ${name}`)];
    return ["npm install --no-package-lock", ...checks.map(name => `npm run ${name}`)];
  }
  if (kind === "python") {
    const installs: string[] = [];
    if (hasFile(files, "requirements.txt")) installs.push("python -m pip install -r requirements.txt");
    if (["pyproject.toml", "setup.py", "setup.cfg"].some(file => hasFile(files, file))) installs.push("python -m pip install -e .");
    return installs.length && hasPythonTestEvidence(root, files) ? [...installs, "python -m pytest"] : [];
  }
  if (kind === "go") return ["go test ./..."];
  if (kind === "rust") return [hasFile(files, "Cargo.lock") ? "cargo test --workspace --all-targets --locked" : "cargo test --workspace --all-targets"];
  return [];
}

export function inspectProject(root: string): ProjectProfile {
  const listing = trackedProjectFiles(root);
  const files = listing.files;
  const counts = sourceCounts(files);
  const scores = ecosystemScores(files, counts);
  const ecosystems = detectedEcosystems(files, counts, scores);
  const kind = projectKind(ecosystems, counts, files);
  const extensions = selectedExtensions(kind, ecosystems, files);
  const dirs = codeDirectories(files, extensions);
  const branch = inferBaseBranch(root);
  const evidence: string[] = [
    `project files (${listing.source}): ${files.length}`,
    ...ecosystems.map(ecosystem => `${ecosystem} source files: ${counts[ecosystem]}`),
    ...ecosystems.flatMap(ecosystem => MANIFESTS[ecosystem].filter(marker => hasFile(files, marker)).map(marker => `${ecosystem} marker: ${marker}`)),
    ...branch.evidence,
  ];
  const issues: string[] = [];
  if (kind === "unknown") issues.push("No supported source ecosystem was detected from project files and manifests.");
  if (kind === "mixed") issues.push(`Multiple source ecosystems require explicit confirmation: ${ecosystems.join(", ")}.`);
  if (!extensions.length) issues.push("No supported source extensions were detected.");
  if (!dirs.length) issues.push("No source directory could be inferred.");
  if (!branch.valid) issues.push("No resolvable base branch could be inferred.");
  const docsDir = docsDirectory(root, files);
  if (!docsDir) issues.push("No documentation directory or root README/index with scannable .md files was detected.");
  const ambiguous = issues.length > 0 || listing.source !== "git" || branch.confidence !== "high";
  const confidence: ProfileConfidence = ambiguous
    ? "low"
    : branch.confidence === "high" && kind !== "mixed" && extensions.length > 0 ? "high" : "medium";
  const fallbackExt: CodeExt = extensions.length === 1 ? extensions[0] : extensions.length ? extensions : ".ts";
  const fallbackDirs = dirs.length ? dirs : ["src"];
  const lintDirs = fallbackDirs.filter(dir => !["test", "tests"].includes(dir.toLowerCase()));
  return {
    root,
    kind,
    ecosystems,
    codeExt: fallbackExt,
    codeDirs: fallbackDirs,
    lintDirs: lintDirs.length ? lintDirs : fallbackDirs,
    docsDir,
    baseBranch: branch.branch,
    confidence,
    ambiguous,
    evidence,
    issues,
    trackedFiles: files,
    ciCandidates: ciCandidates(root, kind, ecosystems, files),
  };
}
